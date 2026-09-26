// Device-free stubs for driver tests: a scripted Appium HTTP server and a fake `adb` whose `shell` runs the command
// string under a real /bin/sh with fake device tools, so quoting is exercised by an actual shell.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A JSON body (serialized as-is when a string), or `destroy` to drop the connection without an answer. */
export type Reply = { status?: number; body: unknown } | 'destroy';

export interface StubRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown> | null;
}

export interface AppiumStub {
  url: string;
  requests: StubRequest[];
  close(): void;
}

/** Answers `POST /session`, settings and window rect for session `s1`; everything else goes to `route`. */
export async function startAppiumStub(route: (req: StubRequest) => Reply | undefined): Promise<AppiumStub> {
  const requests: StubRequest[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d: Buffer) => (raw += d.toString('utf8')));
    req.on('end', () => {
      const r: StubRequest = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null };
      requests.push(r);
      const reply =
        route(r) ??
        (r.method === 'POST' && r.path === '/session'
          ? { body: { value: { sessionId: 's1', capabilities: {} } } }
          : r.path === '/session/s1/window/rect'
            ? { body: { value: { x: 0, y: 0, width: 390, height: 844 } } }
            : { body: { value: null } });
      if (reply === 'destroy') return void req.socket.destroy();
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** `mobile:` script name of an `/execute/sync` request, else null. */
export function scriptOf(req: StubRequest): string | null {
  return req.path.endsWith('/execute/sync') && typeof req.body?.script === 'string' ? req.body.script : null;
}

const ADB = `#!/bin/sh
root="$FAKE_ADB_ROOT"
{ for a in "$@"; do printf '%s\\037' "$a"; done; printf '\\n'; } >> "$root/host.log"
if [ "$1" = "-s" ]; then shift 2; fi
cmd="$1"; shift
case "$cmd" in
  shell) PATH="$root/device:$PATH"; export PATH; exec /bin/sh -c "$*" ;;
  pull) cp "$root/sdcard/$(basename "$1")" "$2" ;;
esac
`;

// One script for every fake device tool; it records its argv and prints what the real tool would.
const DEVICE_TOOL = `#!/bin/sh
root="$FAKE_ADB_ROOT"
name=$(basename "$0")
{ printf '%s\\037' "$name"; for a in "$@"; do printf '%s\\037' "$a"; done; printf '\\n'; } >> "$root/device.log"
for last; do :; done
case "$name $1" in
  "pm clear") echo Success ;;
  "cmd package") echo "$last/.MainActivity" ;;
  "cmd appops") if [ -n "$FAKE_APPOPS_FAIL" ]; then echo "Error: operation failed"; exit 1; fi ;;
  "am start") echo "Status: ok" ;;
  screenrecord*) out="$root/sdcard/$(basename "$last")"; trap 'echo mp4 > "$out"; exit 0' INT; while :; do sleep 0.05; done ;;
esac
exit 0
`;

const DEVICE_TOOLS = ['am', 'pm', 'cmd', 'pidof', 'dumpsys', 'getprop', 'screenrecord', 'pkill', 'rm'];

export interface FakeAdb {
  root: string;
  /** Host argv of every `adb` invocation (without the binary). */
  hostCalls(): string[][];
  /** argv (tool name first) of every fake device tool the device shell ran. */
  deviceCalls(): string[][];
  restore(): void;
}

const calls = (file: string): string[][] => {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\x1f').slice(0, -1));
};

/** Points ANDROID_HOME at a temp SDK whose `platform-tools/adb` is the fake. */
export function installFakeAdb(): FakeAdb {
  const root = mkdtempSync(join(tmpdir(), 'qa-fake-adb-'));
  mkdirSync(join(root, 'platform-tools'));
  mkdirSync(join(root, 'device'));
  mkdirSync(join(root, 'sdcard'));
  writeFileSync(join(root, 'platform-tools', 'adb'), ADB);
  chmodSync(join(root, 'platform-tools', 'adb'), 0o755);
  for (const tool of DEVICE_TOOLS) {
    writeFileSync(join(root, 'device', tool), DEVICE_TOOL);
    chmodSync(join(root, 'device', tool), 0o755);
  }
  const saved = { home: process.env.ANDROID_HOME, root: process.env.FAKE_ADB_ROOT };
  process.env.ANDROID_HOME = root;
  process.env.FAKE_ADB_ROOT = root;
  return {
    root,
    hostCalls: () => calls(join(root, 'host.log')),
    deviceCalls: () => calls(join(root, 'device.log')),
    restore() {
      if (saved.home === undefined) delete process.env.ANDROID_HOME;
      else process.env.ANDROID_HOME = saved.home;
      if (saved.root === undefined) delete process.env.FAKE_ADB_ROOT;
      else process.env.FAKE_ADB_ROOT = saved.root;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
