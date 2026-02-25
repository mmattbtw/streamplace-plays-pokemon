import { JetstreamSubscription } from "@atcute/jetstream";
import { createConnection } from "node:net";

const STREAMER_DID =
  process.env.STREAMER_DID ?? "did:plc:b6dcapsekrslqcsjavnafgag";
const JETSTREAM_URL =
  process.env.JETSTREAM_URL ?? "wss://jetstream2.us-east.bsky.network";
const KEYPRESS_DURATION_MS = Number.parseInt(
  process.env.KEYPRESS_DURATION_MS ?? "80",
  10,
);
const LONG_KEYPRESS_DURATION_MS = Number.parseInt(
  process.env.LONG_KEYPRESS_DURATION_MS ?? `${KEYPRESS_DURATION_MS * 3}`,
  10,
);
const MGBA_HOST = process.env.MGBA_HOST ?? "127.0.0.1";
const MGBA_PORT = Number.parseInt(process.env.MGBA_PORT ?? "8765", 10);
const MGBA_SOCKET_TIMEOUT_MS = Number.parseInt(
  process.env.MGBA_SOCKET_TIMEOUT_MS ?? "1500",
  10,
);
const DRY_RUN = process.env.DRY_RUN === "1";
const OVERLAY_PORT = Number.parseInt(process.env.OVERLAY_PORT ?? "8080", 10);
const SLINGSHOT_URL =
  process.env.SLINGSHOT_URL ?? "https://slingshot.microcosm.blue";
const MAX_CHAT_MESSAGES = 35;
const MAX_QUEUE_ITEMS = 40;
const IDENTITY_CACHE_TTL_MS = 15 * 60 * 1000;
const CHATTER_WINDOW_MS = 10 * 60 * 1000;
const MIN_UNIQUE_CHATTERS_FOR_NO_SPAM = 3;
const MAX_COMMAND_SPAM_REPEAT = 100;
const QUEUE_COMMAND_DELAY_MS = Number.parseInt(
  process.env.QUEUE_COMMAND_DELAY_MS ?? "80",
  10,
);
const SPAM_REPEAT_DELAY_MS = Number.parseInt(
  process.env.SPAM_REPEAT_DELAY_MS ?? "140",
  10,
);

type QueueStatus = "queued" | "active" | "done" | "error";

interface ChatMessage {
  id: string;
  did: string;
  user: string;
  handle?: string;
  avatarUrl?: string;
  text: string;
  isCommand: boolean;
  createdAt: number;
}

interface QueueItem {
  id: string;
  did: string;
  user: string;
  handle?: string;
  avatarUrl?: string;
  command: string;
  status: QueueStatus;
  createdAt: number;
}

interface OverlaySnapshot {
  chat: ChatMessage[];
  queue: QueueItem[];
  activeCommandId: string | null;
  spamAbility: {
    enabled: boolean;
    uniqueChatters: number;
    threshold: number;
    windowMinutes: number;
  };
}

interface ResolvedIdentity {
  did: string;
  handle?: string;
  displayName?: string;
  avatarUrl?: string;
}

interface ParsedCommand {
  buttons: string[];
  durationMs: number;
  normalized: string;
  repeatCount: number;
}

const SUPPORTED_COMMANDS = new Set([
  "up",
  "down",
  "left",
  "right",
  "a",
  "b",
  "start",
  "select",
  "l",
  "r",
]);

const overlayClients = new Set<ReadableStreamDefaultController<string>>();
const chatMessages: ChatMessage[] = [];
const commandQueue: QueueItem[] = [];
const identityCache = new Map<
  string,
  { identity: ResolvedIdentity; expiresAt: number }
>();
const pendingIdentityLookups = new Map<string, Promise<ResolvedIdentity | null>>();
const chatterActivity: Array<{ did: string; createdAt: number }> = [];
let activeCommandId: string | null = null;
let processingQueue = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeCommand(raw: string): string {
  return raw.trim().toLowerCase();
}

function parseCommand(raw: string, options?: { allowCommandSpam?: boolean }): ParsedCommand | null {
  const normalizedRaw = normalizeCommand(raw);
  if (normalizedRaw.length === 0) {
    return null;
  }

  const spamMatch = normalizedRaw.match(/^(.+?)\s+x(\d+)$/);
  if (spamMatch) {
    if (!options?.allowCommandSpam) {
      return null;
    }

    const commandRaw = spamMatch[1];
    if (commandRaw === undefined) {
      return null;
    }

    const repeatRaw = spamMatch[2];
    if (repeatRaw === undefined) {
      return null;
    }
    const repeatCount = Number.parseInt(repeatRaw, 10);
    if (
      !Number.isInteger(repeatCount) ||
      repeatCount < 2 ||
      repeatCount > MAX_COMMAND_SPAM_REPEAT
    ) {
      return null;
    }

    const baseCommand = parseCommand(commandRaw, { allowCommandSpam: false });
    if (!baseCommand) {
      return null;
    }

    return {
      buttons: baseCommand.buttons,
      durationMs: baseCommand.durationMs,
      normalized: baseCommand.normalized,
      repeatCount,
    };
  }

  const isExtendedHold = normalizedRaw.endsWith("-");
  const base = isExtendedHold
    ? normalizedRaw.slice(0, -1).trim()
    : normalizedRaw;
  if (base.length === 0) {
    return null;
  }

  const buttons = base.split("+").map((part) => part.trim());
  if (buttons.length === 0 || buttons.length > 2) {
    return null;
  }

  for (const button of buttons) {
    if (button.length === 0 || !SUPPORTED_COMMANDS.has(button)) {
      return null;
    }
  }

  const durationMs = isExtendedHold
    ? LONG_KEYPRESS_DURATION_MS
    : KEYPRESS_DURATION_MS;
  return {
    buttons,
    durationMs,
    normalized: `${buttons.join("+")}${isExtendedHold ? "-" : ""}`,
    repeatCount: 1,
  };
}

function countUniqueChattersInWindow(now: number): number {
  const cutoff = now - CHATTER_WINDOW_MS;
  while (true) {
    const first = chatterActivity[0];
    if (!first || first.createdAt >= cutoff) {
      break;
    }
    chatterActivity.shift();
  }
  return new Set(chatterActivity.map((entry) => entry.did)).size;
}

function recordChatterAndCountUnique(did: string, now: number): number {
  chatterActivity.push({ did, createdAt: now });
  return countUniqueChattersInWindow(now);
}

function readMessageText(record: Record<string, unknown>): string | undefined {
  const candidates = [
    record.text,
    record.message,
    record.body,
    record.content,
    typeof record.msg === "string" ? record.msg : undefined,
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function shortenDid(did: string): string {
  if (did.length <= 18) {
    return did;
  }

  return `${did.slice(0, 10)}...${did.slice(-5)}`;
}

function formatHandle(handle: string): string {
  const normalized = handle.startsWith("@") ? handle.slice(1) : handle;
  return `@${normalized}`;
}

function readFirstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function localIdentityFromRecord(
  did: string,
  record: Record<string, unknown>,
): ResolvedIdentity | null {
  const handle = readFirstNonEmptyString(record.handle, record.username, record.userHandle);
  const displayName = readFirstNonEmptyString(
    record.displayName,
    record.name,
    record.user,
    record.sender,
    record.author,
  );
  const avatarUrl = readFirstNonEmptyString(
    record.avatarUrl,
    record.avatar,
    record.pfp,
    record.profileImage,
  );

  if (!handle && !displayName && !avatarUrl) {
    return null;
  }

  return { did, handle, displayName, avatarUrl };
}

function readUser(record: Record<string, unknown>, did: string): string {
  const candidates = [record.user, record.sender, record.author, record.handle];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return shortenDid(did);
}

function userLabelForIdentity(identity: ResolvedIdentity, fallbackDid: string): string {
  if (identity.displayName && identity.displayName.trim().length > 0) {
    return identity.displayName.trim();
  }

  if (identity.handle && identity.handle.trim().length > 0) {
    return formatHandle(identity.handle.trim());
  }

  return shortenDid(fallbackDid);
}

function queueLabelForIdentity(identity: ResolvedIdentity, fallbackDid: string): string {
  if (identity.handle && identity.handle.trim().length > 0) {
    return formatHandle(identity.handle.trim());
  }

  return shortenDid(fallbackDid);
}

function cachedIdentityForDid(did: string): ResolvedIdentity | null {
  const cached = identityCache.get(did);
  if (!cached || cached.expiresAt <= Date.now()) {
    return null;
  }

  return cached.identity;
}

function snapshot(): OverlaySnapshot {
  const uniqueChatters = countUniqueChattersInWindow(Date.now());
  return {
    chat: chatMessages,
    queue: commandQueue,
    activeCommandId,
    spamAbility: {
      enabled: uniqueChatters < MIN_UNIQUE_CHATTERS_FOR_NO_SPAM,
      uniqueChatters,
      threshold: MIN_UNIQUE_CHATTERS_FOR_NO_SPAM,
      windowMinutes: CHATTER_WINDOW_MS / (60 * 1000),
    },
  };
}

function sendToClient(
  controller: ReadableStreamDefaultController<string>,
  data: OverlaySnapshot,
): void {
  controller.enqueue(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(): void {
  const data = snapshot();
  for (const client of [...overlayClients]) {
    try {
      sendToClient(client, data);
    } catch {
      overlayClients.delete(client);
    }
  }
}

function pushChatMessage(
  did: string,
  user: string,
  text: string,
  isCommand: boolean,
): void {
  const message: ChatMessage = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 9)}`,
    did,
    user,
    text,
    isCommand,
    createdAt: Date.now(),
  };

  chatMessages.push(message);
  if (chatMessages.length > MAX_CHAT_MESSAGES) {
    chatMessages.splice(0, chatMessages.length - MAX_CHAT_MESSAGES);
  }

  broadcast();
}

function applyIdentityToOverlay(identity: ResolvedIdentity): void {
  let changed = false;

  for (const message of chatMessages) {
    if (message.did !== identity.did) {
      continue;
    }

    const user = userLabelForIdentity(identity, identity.did);
    if (
      message.user !== user ||
      message.handle !== identity.handle ||
      message.avatarUrl !== identity.avatarUrl
    ) {
      message.user = user;
      message.handle = identity.handle;
      message.avatarUrl = identity.avatarUrl;
      changed = true;
    }
  }

  for (const item of commandQueue) {
    if (item.did !== identity.did) {
      continue;
    }

    const user = queueLabelForIdentity(identity, identity.did);
    if (
      item.user !== user ||
      item.handle !== identity.handle ||
      item.avatarUrl !== identity.avatarUrl
    ) {
      item.user = user;
      item.handle = identity.handle;
      item.avatarUrl = identity.avatarUrl;
      changed = true;
    }
  }

  if (changed) {
    broadcast();
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (!isObject(value)) {
    return null;
  }

  return value;
}

function extractAvatarUrl(did: string, profileValue: Record<string, unknown>): string | undefined {
  const avatar = parseJsonObject(profileValue.avatar);
  const ref = avatar ? parseJsonObject(avatar.ref) : null;
  const link = ref?.$link;
  if (typeof link !== "string" || link.length === 0) {
    return undefined;
  }

  return `https://cdn.bsky.app/img/avatar/plain/${did}/${link}@jpeg`;
}

async function fetchIdentityFromSlingshot(did: string): Promise<ResolvedIdentity | null> {
  const identityUrl = new URL(
    "/xrpc/blue.microcosm.identity.resolveMiniDoc",
    SLINGSHOT_URL,
  );
  identityUrl.searchParams.set("identifier", did);

  const profileUrl = new URL("/xrpc/com.atproto.repo.getRecord", SLINGSHOT_URL);
  profileUrl.searchParams.set("repo", did);
  profileUrl.searchParams.set("collection", "app.bsky.actor.profile");
  profileUrl.searchParams.set("rkey", "self");

  const [identityResult, profileResult] = await Promise.allSettled([
    fetch(identityUrl),
    fetch(profileUrl),
  ]);

  let handle: string | undefined;
  let displayName: string | undefined;
  let avatarUrl: string | undefined;

  if (identityResult.status === "fulfilled" && identityResult.value.ok) {
    const payload = (await identityResult.value.json()) as Record<string, unknown>;
    if (typeof payload.handle === "string" && payload.handle.trim().length > 0) {
      handle = payload.handle.trim();
    }
  }

  if (profileResult.status === "fulfilled" && profileResult.value.ok) {
    const payload = (await profileResult.value.json()) as Record<string, unknown>;
    const profileValue = parseJsonObject(payload.value);
    if (profileValue) {
      if (
        typeof profileValue.displayName === "string" &&
        profileValue.displayName.trim().length > 0
      ) {
        displayName = profileValue.displayName.trim();
      }
      avatarUrl = extractAvatarUrl(did, profileValue);
    }
  }

  if (!handle && !displayName && !avatarUrl) {
    return null;
  }

  return { did, handle, displayName, avatarUrl };
}

function hydrateIdentity(did: string): void {
  const now = Date.now();
  const cached = identityCache.get(did);
  if (cached && cached.expiresAt > now) {
    applyIdentityToOverlay(cached.identity);
    return;
  }

  if (pendingIdentityLookups.has(did)) {
    return;
  }

  const lookup = fetchIdentityFromSlingshot(did)
    .then((identity) => {
      if (!identity) {
        return null;
      }

      identityCache.set(did, {
        identity,
        expiresAt: Date.now() + IDENTITY_CACHE_TTL_MS,
      });
      applyIdentityToOverlay(identity);
      return identity;
    })
    .catch((error) => {
      console.error(`Failed to resolve identity for ${did}:`, error);
      return null;
    })
    .finally(() => {
      pendingIdentityLookups.delete(did);
    });

  pendingIdentityLookups.set(did, lookup);
}

function cacheLocalIdentity(identity: ResolvedIdentity): void {
  identityCache.set(identity.did, {
    identity,
    expiresAt: Date.now() + IDENTITY_CACHE_TTL_MS,
  });
  applyIdentityToOverlay(identity);
}

function trimQueue(): void {
  if (commandQueue.length <= MAX_QUEUE_ITEMS) {
    return;
  }

  const overflow = commandQueue.length - MAX_QUEUE_ITEMS;
  commandQueue.splice(0, overflow);
}

async function dispatchMgbaCommand(buttons: string[], durationMs: number): Promise<void> {
  if (DRY_RUN) {
    console.log(
      `[DRY_RUN] ${buttons.join("+")} (${durationMs}ms) -> ${MGBA_HOST}:${MGBA_PORT}`,
    );
    await sleep(durationMs);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: MGBA_HOST, port: MGBA_PORT });
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(error);
    };

    socket.setTimeout(MGBA_SOCKET_TIMEOUT_MS);

    socket.once("timeout", () => {
      fail(
        new Error(
          `Timed out sending command to mGBA bridge at ${MGBA_HOST}:${MGBA_PORT}`,
        ),
      );
    });

    socket.once("error", (error) => {
      fail(error);
    });

    socket.once("connect", () => {
      const payload = buttons.map((button) => `press ${button} ${durationMs}\n`).join("");
      socket.write(payload, "utf8", (error) => {
        if (error) {
          fail(error);
          return;
        }
        socket.end();
      });
    });

    socket.once("close", (hadError) => {
      if (settled) {
        return;
      }
      settled = true;
      if (hadError) {
        reject(
          new Error(
            `Socket closed with error while sending to ${MGBA_HOST}:${MGBA_PORT}`,
          ),
        );
      } else {
        resolve();
      }
    });
  });
}

function buildQueueItem(command: string, did: string): QueueItem {
  const cachedIdentity = cachedIdentityForDid(did);
  const user = cachedIdentity
    ? queueLabelForIdentity(cachedIdentity, did)
    : shortenDid(did);
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 9)}`,
    did,
    user,
    handle: cachedIdentity?.handle,
    avatarUrl: cachedIdentity?.avatarUrl,
    command,
    status: "queued",
    createdAt: Date.now(),
  };
}

function enqueueSingleCommand(command: string, did: string): void {
  commandQueue.push(buildQueueItem(command, did));
  trimQueue();
  broadcast();
  void processQueue();
}

function enqueueCommand(command: ParsedCommand, did: string): void {
  enqueueSingleCommand(command.normalized, did);

  if (command.repeatCount <= 1) {
    return;
  }

  void (async () => {
    for (let i = 1; i < command.repeatCount; i += 1) {
      await sleep(SPAM_REPEAT_DELAY_MS);
      enqueueSingleCommand(command.normalized, did);
    }
  })();
}

async function processQueue(): Promise<void> {
  if (processingQueue) {
    return;
  }

  processingQueue = true;
  try {
    while (true) {
      const next = commandQueue.find((item) => item.status === "queued");
      if (!next) {
        activeCommandId = null;
        broadcast();
        return;
      }

      const parsedCommand = parseCommand(next.command);
      if (!parsedCommand) {
        next.status = "error";
        broadcast();
        continue;
      }

      next.status = "active";
      activeCommandId = next.id;
      broadcast();

      try {
        await dispatchMgbaCommand(parsedCommand.buttons, parsedCommand.durationMs);
        next.status = "done";
      } catch (error) {
        next.status = "error";
        console.error(`Failed to dispatch command "${next.command}":`, error);
      }

      activeCommandId = null;
      broadcast();
      await sleep(QUEUE_COMMAND_DELAY_MS);
    }
  } finally {
    processingQueue = false;
  }
}

function htmlPage(): Response {
  return new Response(Bun.file("overlay.html"), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function sseStream(request: Request): Response {
  const stream = new ReadableStream<string>({
    start(controller) {
      overlayClients.add(controller);
      controller.enqueue("retry: 1500\n\n");
      sendToClient(controller, snapshot());

      request.signal.addEventListener("abort", () => {
        overlayClients.delete(controller);
        try {
          controller.close();
        } catch {
          // stream already closed
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

Bun.serve({
  port: OVERLAY_PORT,
  fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/overlay" || url.pathname === "/") {
      return htmlPage();
    }

    if (url.pathname === "/events") {
      return sseStream(request);
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log("Starting Stream.Place Plays listener");
console.log(`Jetstream URL: ${JETSTREAM_URL}`);
console.log(`Streamer DID filter: ${STREAMER_DID}`);
console.log(`mGBA bridge target: ${MGBA_HOST}:${MGBA_PORT}`);
console.log(`Overlay URL: http://localhost:${OVERLAY_PORT}/overlay`);
console.log(`Slingshot URL: ${SLINGSHOT_URL}`);
console.log(`mGBA socket timeout: ${MGBA_SOCKET_TIMEOUT_MS}ms`);

const subscription = new JetstreamSubscription({
  url: JETSTREAM_URL,
  wantedCollections: ["place.stream.chat.message"],
});

for await (const event of subscription) {
  if (event.kind !== "commit") {
    continue;
  }

  const commit = event.commit;
  if (commit.collection !== "place.stream.chat.message") {
    continue;
  }

  if (commit.operation !== "create" && commit.operation !== "update") {
    continue;
  }

  if (!isObject(commit.record)) {
    continue;
  }

  const record = commit.record;
  if (record.streamer !== STREAMER_DID) {
    continue;
  }

  const text = readMessageText(record);
  if (!text) {
    continue;
  }

  const now = Date.now();
  const uniqueChatters = recordChatterAndCountUnique(event.did, now);
  const allowCommandSpam = uniqueChatters < MIN_UNIQUE_CHATTERS_FOR_NO_SPAM;
  const parsedCommand = parseCommand(text, { allowCommandSpam });
  const isCommand = parsedCommand !== null;
  const user = readUser(record, event.did);

  pushChatMessage(event.did, user, text, isCommand);
  const localIdentity = localIdentityFromRecord(event.did, record);
  if (localIdentity) {
    cacheLocalIdentity(localIdentity);
  }
  hydrateIdentity(event.did);

  if (!parsedCommand) {
    continue;
  }

  console.log(`accepted "${parsedCommand.normalized}" from ${user}`);
  enqueueCommand(parsedCommand, event.did);
}
