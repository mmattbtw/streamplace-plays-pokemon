local HOST = os.getenv("MGBA_BRIDGE_HOST") or "127.0.0.1"
local PORT = tonumber(os.getenv("MGBA_BRIDGE_PORT") or "8765")
local DEFAULT_DURATION_MS = tonumber(os.getenv("MGBA_BRIDGE_DURATION_MS") or "80")

local COMMAND_TO_KEY = {
  up = "UP",
  down = "DOWN",
  left = "LEFT",
  right = "RIGHT",
  a = "A",
  b = "B",
  start = "START",
  select = "SELECT",
  l = "L",
  r = "R",
}

local function duration_to_frames(duration_ms)
  local ms = tonumber(duration_ms) or DEFAULT_DURATION_MS
  if ms < 1 then
    ms = 1
  end
  local frames = math.floor((ms / 1000) * 60 + 0.5)
  if frames < 1 then
    frames = 1
  end
  return frames
end

local function trim(s)
  return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

local server = assert(socket.bind(HOST, PORT))
assert(server:listen(8))

local clients = {}
local held_until = {}

local function remove_client_at(index)
  table.remove(clients, index)
end

local function handle_command_line(line)
  local cmd, button, duration = string.match(line, "^(%S+)%s+(%S+)%s*(%S*)%s*$")
  if cmd ~= "press" or button == nil then
    return
  end

  local key_name = COMMAND_TO_KEY[string.lower(button)]
  if key_name == nil then
    return
  end

  local key = C.GBA_KEY[key_name]
  if key == nil then
    return
  end

  local frame = emu:currentFrame()
  local release_frame = frame + duration_to_frames(duration)

  local existing = held_until[key]
  if existing == nil or release_frame > existing then
    held_until[key] = release_frame
  end

  emu:addKey(key)
end

local function poll_clients()
  server:poll()
  while true do
    local client = server:accept()
    if client == nil then
      break
    end
    table.insert(clients, { socket = client, buffer = "" })
  end

  local i = 1
  while i <= #clients do
    local entry = clients[i]
    entry.socket:poll()
    local chunk, err = entry.socket:receive(4096)

    if err ~= nil and err ~= socket.ERRORS.AGAIN and err ~= socket.ERRORS.NO_DATA then
      remove_client_at(i)
    else
      if chunk ~= nil and #chunk > 0 then
        entry.buffer = entry.buffer .. chunk

        while true do
          local newline = string.find(entry.buffer, "\n", 1, true)
          if newline == nil then
            break
          end

          local line = trim(string.sub(entry.buffer, 1, newline - 1))
          entry.buffer = string.sub(entry.buffer, newline + 1)

          if #line > 0 then
            handle_command_line(line)
          end
        end
      end
      i = i + 1
    end
  end
end

callbacks:add("frame", function()
  poll_clients()

  local frame = emu:currentFrame()
  for key, release_frame in pairs(held_until) do
    if frame >= release_frame then
      emu:clearKey(key)
      held_until[key] = nil
    else
      emu:addKey(key)
    end
  end
end)

console:log(string.format("mGBA bridge listening on %s:%d", HOST, PORT))
