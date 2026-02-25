import { JetstreamSubscription } from "@atcute/jetstream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const STREAMER_DID =
  process.env.STREAMER_DID ?? "did:plc:b6dcapsekrslqcsjavnafgag";
const JETSTREAM_URL =
  process.env.JETSTREAM_URL ?? "wss://jetstream2.us-east.bsky.network";
const KEYPRESS_DURATION_MS = Number.parseInt(
  process.env.KEYPRESS_DURATION_MS ?? "80",
  10,
);
const DRY_RUN = process.env.DRY_RUN === "1";
const OVERLAY_PORT = Number.parseInt(process.env.OVERLAY_PORT ?? "8080", 10);
const SLINGSHOT_URL =
  process.env.SLINGSHOT_URL ?? "https://slingshot.microcosm.blue";
const MAX_CHAT_MESSAGES = 35;
const MAX_QUEUE_ITEMS = 40;
const IDENTITY_CACHE_TTL_MS = 15 * 60 * 1000;

type KeySpec =
  | { type: "char"; value: string }
  | { type: "macCode"; value: number }
  | { type: "linuxKey"; value: string };

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
}

interface ResolvedIdentity {
  did: string;
  handle?: string;
  displayName?: string;
  avatarUrl?: string;
}

const COMMAND_TO_KEY = new Map<string, KeySpec>([
  ["up", { type: "char", value: "i" }],
  ["down", { type: "char", value: "k" }],
  ["left", { type: "char", value: "j" }],
  ["right", { type: "char", value: "l" }],
  ["a", { type: "char", value: "a" }],
  ["b", { type: "char", value: "b" }],
  ["start", { type: "char", value: "o" }],
  ["select", { type: "char", value: "p" }],
  ["l", { type: "char", value: "l" }],
  ["r", { type: "char", value: "r" }],
]);

const CHAR_TO_LINUX_KEY = new Map<string, string>([
  ["a", "a"],
  ["b", "b"],
  ["i", "i"],
  ["j", "j"],
  ["k", "k"],
  ["l", "l"],
  ["o", "o"],
  ["p", "p"],
  ["r", "r"],
]);

const MAC_CODE_TO_LINUX_KEY = new Map<number, string>([
  [126, "Up"],
  [125, "Down"],
  [123, "Left"],
  [124, "Right"],
  [36, "Return"],
  [51, "BackSpace"],
]);

const overlayClients = new Set<ReadableStreamDefaultController<string>>();
const chatMessages: ChatMessage[] = [];
const commandQueue: QueueItem[] = [];
const identityCache = new Map<
  string,
  { identity: ResolvedIdentity; expiresAt: number }
>();
const pendingIdentityLookups = new Map<string, Promise<ResolvedIdentity | null>>();
let activeCommandId: string | null = null;
let processingQueue = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeCommand(raw: string): string {
  return raw.trim().toLowerCase();
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
  return {
    chat: chatMessages,
    queue: commandQueue,
    activeCommandId,
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

async function runMacKeypress(key: KeySpec): Promise<void> {
  let script: string;

  if (key.type === "macCode") {
    script = `tell application "System Events" to key down key code ${key.value}
delay ${KEYPRESS_DURATION_MS / 1000}
tell application "System Events" to key up key code ${key.value}`;
  } else if (key.type === "char") {
    script = `tell application "System Events" to key down "${key.value}"
delay ${KEYPRESS_DURATION_MS / 1000}
tell application "System Events" to key up "${key.value}"`;
  } else {
    throw new Error(`Unsupported macOS key type: ${key.type}`);
  }

  await execFileAsync("osascript", ["-e", script]);
}

async function runLinuxKeypress(key: KeySpec): Promise<void> {
  const linuxKey =
    key.type === "linuxKey"
      ? key.value
      : key.type === "char"
        ? CHAR_TO_LINUX_KEY.get(key.value)
        : MAC_CODE_TO_LINUX_KEY.get(key.value);

  if (!linuxKey) {
    throw new Error(`No Linux key mapping for ${JSON.stringify(key)}`);
  }

  await execFileAsync("xdotool", ["key", "--clearmodifiers", linuxKey]);
}

async function dispatchKeypress(key: KeySpec, command: string): Promise<void> {
  if (DRY_RUN) {
    console.log(`[DRY_RUN] ${command} -> ${JSON.stringify(key)}`);
    await sleep(KEYPRESS_DURATION_MS);
    return;
  }

  if (process.platform === "darwin") {
    await runMacKeypress(key);
    return;
  }

  if (process.platform === "linux") {
    await runLinuxKeypress(key);
    return;
  }

  throw new Error(
    `Unsupported platform: ${process.platform}. Implement keypress support for this OS.`,
  );
}

function enqueueCommand(command: string, did: string): void {
  const cachedIdentity = cachedIdentityForDid(did);
  const user = cachedIdentity
    ? queueLabelForIdentity(cachedIdentity, did)
    : shortenDid(did);
  const item: QueueItem = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 9)}`,
    did,
    user,
    handle: cachedIdentity?.handle,
    avatarUrl: cachedIdentity?.avatarUrl,
    command,
    status: "queued",
    createdAt: Date.now(),
  };

  commandQueue.push(item);
  trimQueue();
  broadcast();

  void processQueue();
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

      const key = COMMAND_TO_KEY.get(next.command);
      if (!key) {
        next.status = "error";
        broadcast();
        continue;
      }

      next.status = "active";
      activeCommandId = next.id;
      broadcast();

      try {
        await dispatchKeypress(key, next.command);
        next.status = "done";
      } catch (error) {
        next.status = "error";
        console.error(`Failed to dispatch command "${next.command}":`, error);
      }

      activeCommandId = null;
      broadcast();
      await sleep(80);
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
console.log(`Keyboard output platform: ${process.platform}`);
console.log(`Overlay URL: http://localhost:${OVERLAY_PORT}/overlay`);
console.log(`Slingshot URL: ${SLINGSHOT_URL}`);

if (process.platform === "darwin") {
  console.log(
    "macOS note: give Terminal/Codex Accessibility permissions so osascript can send key events.",
  );
}

if (process.platform === "linux") {
  console.log("Linux note: install xdotool for key event output.");
}

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

  const command = normalizeCommand(text);
  const key = COMMAND_TO_KEY.get(command);
  const user = readUser(record, event.did);

  pushChatMessage(event.did, user, text, Boolean(key));
  const localIdentity = localIdentityFromRecord(event.did, record);
  if (localIdentity) {
    cacheLocalIdentity(localIdentity);
  }
  hydrateIdentity(event.did);

  if (!key) {
    continue;
  }

  console.log(`accepted "${command}" from ${user}`);
  enqueueCommand(command, event.did);
}
