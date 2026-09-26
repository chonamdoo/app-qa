// Device-free stubs for driver tests: a scripted Appium HTTP server and a fake `adb` whose `shell` runs the command
// string under a real /bin/sh with fake device tools, so quoting is exercised by an actual shell.
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// FAKE_ADB_DROP: once the device shell ran that command (see DEVICE_TOOL), adb loses the stream: its stdout is dropped,
// FAKE_ADB_DROP_STDERR is printed and it exits FAKE_ADB_DROP_EXIT. `logcat` prints logcat.txt, then — when the test
// made a logcat.fifo — whatever the test writes to it: a stream that stays open until the test ends it.
// `reverse` keeps the device's port mappings in reverse.txt (`host-1 <device spec> <host spec>` lines, as adb lists
// them); `push` stores the file as state/<name>.
const ADB = `#!/bin/sh
root="$FAKE_ADB_ROOT"
{ for a in "$@"; do printf '%s\\037' "$a"; done; printf '\\n'; } >> "$root/host.log"
if [ "$1" = "-s" ]; then shift 2; fi
cmd="$1"; shift
for last; do :; done
case "$cmd" in
  shell)
    PATH="$root/device:$PATH"; export PATH
    [ -z "$FAKE_ADB_DROP" ] && exec /bin/sh -c "$*"
    out=$(/bin/sh -c "$*"); rc=$?
    if [ -e "$root/dropped" ]; then
      [ -n "$FAKE_ADB_DROP_STDERR" ] && printf '%s\\n' "$FAKE_ADB_DROP_STDERR" >&2
      exit "$FAKE_ADB_DROP_EXIT"
    fi
    [ -n "$out" ] && printf '%s\\n' "$out"
    exit $rc ;;
  install|install-multiple) if [ -n "$FAKE_INSTALL_FAILURE" ]; then echo "adb: failed to install $last: $FAKE_INSTALL_FAILURE" >&2; exit 1; fi ;;
  pull) cp "$root/sdcard/$(basename "$1")" "$2" ;;
  logcat) cat "$root/logcat.txt"; if [ -p "$root/logcat.fifo" ]; then cat "$root/logcat.fifo"; fi ;;
  reverse)
    f="$root/reverse.txt"; touch "$f"
    case "$1" in
      --list) cat "$f" ;;
      --no-rebind) if grep -q "^host-1 $2 " "$f"; then echo "adb: error: cannot rebind existing socket" >&2; exit 1; fi; echo "host-1 $2 $3" >> "$f" ;;
      --remove) grep -v "^host-1 $2 " "$f" > "$f.tmp"; mv "$f.tmp" "$f" ;;
    esac ;;
  push) cp "$1" "$root/state/$(basename "$2")" ;;
esac
`;

// One script for every fake device tool; it records its argv and prints what the real tool would. Chrome's device
// state lives in state/: chrome-installed, debug_app, chrome-command-line, granted (runtime permissions granted);
// ime-visible (true/false) is what `dumpsys window InputMethod` reports. `date` prints the host clock shifted by
// FAKE_DEVICE_CLOCK_SKEW_MS (`+%s.%N`, millisecond precision).
const DEVICE_TOOL = `#!/bin/sh
root="$FAKE_ADB_ROOT"
name=$(basename "$0")
{ printf '%s\\037' "$name"; for a in "$@"; do printf '%s\\037' "$a"; done; printf '\\n'; } >> "$root/device.log"
[ "$name $1" = "$FAKE_ADB_DROP" ] && : > "$root/dropped"
[ "$name $1" = "$FAKE_DEVICE_KILL" ] && kill -KILL $$
for last; do :; done
case "$name $1" in
  "pm clear") /bin/rm -f "$root/state/granted"; echo Success ;;
  "pm grant") echo "$3" >> "$root/state/granted" ;;
  "am set-debug-app") printf '%s\\n' "$last" > "$root/state/debug_app" ;;
  "settings get") if [ -e "$root/state/$3" ]; then /bin/cat "$root/state/$3"; else echo null; fi ;;
  "getprop ro.build.version.sdk") echo 36 ;;
  date*) perl -MTime::HiRes=time -e 'printf("%.3f\\n", time() + ($ENV{FAKE_DEVICE_CLOCK_SKEW_MS} || 0) / 1000)' ;;
  "dumpsys window") if [ -e "$root/state/ime-visible" ]; then echo "  isVisible=$(/bin/cat "$root/state/ime-visible")"; fi ;;
  "dumpsys package")
    if [ ! -e "$root/state/chrome-installed" ]; then echo "Unable to find package: $2"; exit 0; fi
    granted=false; grep -qx android.permission.POST_NOTIFICATIONS "$root/state/granted" 2>/dev/null && granted=true
    printf 'Packages:\\n  Package [%s] (1b396b6):\\n    versionName=153.0.8010.37\\n    User 0: ceDataInode=1 installed=true hidden=false stopped=false enabled=0 instant=false\\n      runtime permissions:\\n        android.permission.POST_NOTIFICATIONS: granted=%s, flags=[ ]\\nHidden system packages:\\n  Package [%s] (8c61032):\\n    versionName=149.0.7827.5\\n' "$2" "$granted" "$2" ;;
  "cat /data/local/tmp/"*) f="$root/state/$(basename "$1")"; if [ -e "$f" ]; then exec /bin/cat "$f"; fi; echo "cat: $1: No such file or directory" >&2; exit 1 ;;
  cat*) exec /bin/cat "$@" ;;
  "cmd package") echo "$last/.MainActivity" ;;
  "cmd appops") if [ -n "$FAKE_APPOPS_FAIL" ]; then echo "Error: operation failed"; exit 1; fi ;;
  "am start") echo "Status: ok" ;;
  pidof*) echo 4242 ;;
  screenrecord*) out="$root/sdcard/$(basename "$last")"; trap 'echo mp4 > "$out"; exit 0' INT; while :; do sleep 0.05; done ;;
esac
exit 0
`;

const DEVICE_TOOLS = ['am', 'pm', 'cmd', 'pidof', 'dumpsys', 'getprop', 'screenrecord', 'pkill', 'rm', 'settings', 'cat', 'date'];

export interface FakeAdb {
  root: string;
  /** Host argv of every `adb` invocation (without the binary). */
  hostCalls(): string[][];
  /** argv (tool name first) of every fake device tool the device shell ran. */
  deviceCalls(): string[][];
  /**
   * Transport loss right after the device ran `command` (tool + first argument, e.g. `am start`): adb drops that shell's
   * output, prints `stderr` and exits `exit` — for every later shell too, until the next `dropAfter`.
   */
  dropAfter(command: string, stderr: string, exit: number): void;
  /** The device tool running `command` (tool + first argument) is killed by SIGKILL after recording its call (`$?` = 137). */
  killOn(command: string): void;
  /** `adb install` / `install-multiple` fail with the package manager's `failure` text on stderr (exit 1). */
  failInstall(failure: string): void;
  /** Device state file `state/<name>` (see DEVICE_TOOL): written when `content` is given, else read (null when absent). */
  state(name: string, content?: string): string | null;
  /** Port mappings as `adb reverse --list` prints them. */
  reverseList(): string[];
  /** An existing port mapping made by someone else. */
  addReverse(deviceSpec: string, hostSpec: string): void;
  /** The device clock runs `ms` ahead of the host (negative = behind). */
  skewClock(ms: number): void;
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
  mkdirSync(join(root, 'state'));
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
    dropAfter(command, stderr, exit) {
      rmSync(join(root, 'dropped'), { force: true });
      Object.assign(process.env, { FAKE_ADB_DROP: command, FAKE_ADB_DROP_STDERR: stderr, FAKE_ADB_DROP_EXIT: String(exit) });
    },
    killOn(command) {
      process.env.FAKE_DEVICE_KILL = command;
    },
    failInstall(failure) {
      process.env.FAKE_INSTALL_FAILURE = failure;
    },
    state(name, content) {
      const file = join(root, 'state', name);
      if (content !== undefined) writeFileSync(file, content);
      return existsSync(file) ? readFileSync(file, 'utf8') : null;
    },
    reverseList: () => (existsSync(join(root, 'reverse.txt')) ? readFileSync(join(root, 'reverse.txt'), 'utf8').split('\n').filter(Boolean) : []),
    addReverse(deviceSpec, hostSpec) {
      appendFileSync(join(root, 'reverse.txt'), `host-1 ${deviceSpec} ${hostSpec}\n`);
    },
    skewClock(ms) {
      process.env.FAKE_DEVICE_CLOCK_SKEW_MS = String(ms);
    },
    restore() {
      if (saved.home === undefined) delete process.env.ANDROID_HOME;
      else process.env.ANDROID_HOME = saved.home;
      if (saved.root === undefined) delete process.env.FAKE_ADB_ROOT;
      else process.env.FAKE_ADB_ROOT = saved.root;
      for (const key of ['FAKE_ADB_DROP', 'FAKE_ADB_DROP_STDERR', 'FAKE_ADB_DROP_EXIT', 'FAKE_DEVICE_KILL', 'FAKE_INSTALL_FAILURE', 'FAKE_DEVICE_CLOCK_SKEW_MS']) delete process.env[key];
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// Fake `xcrun` / `plutil` on PATH. simctl lists devices.json, reports Safari's app bundle and the data container named in
// `container`; every other simctl command succeeds silently. Every xcrun argv is recorded in xcrun.log.
const XCRUN = `#!/bin/sh
root="$FAKE_XCRUN_ROOT"
{ for a in "$@"; do printf '%s\\037' "$a"; done; printf '\\n'; } >> "$root/xcrun.log"
[ "$1" = simctl ] || exit 0
case "$2" in
  list) cat "$root/devices.json" ;;
  get_app_container) if [ "$5" = data ]; then cat "$root/container"; else echo "$root/MobileSafari.app"; fi ;;
esac
exit 0
`;

export interface FakeXcrun {
  root: string;
  /** Safari data container of the simulator, shaped like CoreSimulator's (`…/Devices/<udid>/data/Containers/Data/Application/<uuid>`). */
  container: string;
  /** argv of every `xcrun` invocation (without the binary). */
  calls(): string[][];
  /** Makes `simctl get_app_container … data` print `path` instead. */
  reportContainer(path: string): void;
  restore(): void;
}

/** Puts a fake `xcrun` (+ `plutil` printing a version) first on PATH; `simctl list` shows `booted` as the only booted simulator. */
export function installFakeXcrun(booted: string): FakeXcrun {
  const root = mkdtempSync(join(tmpdir(), 'qa-fake-xcrun-'));
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin', 'xcrun'), XCRUN);
  writeFileSync(join(root, 'bin', 'plutil'), '#!/bin/sh\necho 26.5\n');
  for (const tool of ['xcrun', 'plutil']) chmodSync(join(root, 'bin', tool), 0o755);
  const devices = { devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ udid: booted, name: 'iPhone 17 Pro', state: 'Booted', isAvailable: true }] } };
  writeFileSync(join(root, 'devices.json'), JSON.stringify(devices));
  const container = join(root, 'CoreSimulator', 'Devices', booted, 'data', 'Containers', 'Data', 'Application', '8468993D-30DE-4468-B04C-5F2C9D353963');
  mkdirSync(container, { recursive: true });
  writeFileSync(join(root, 'container'), `${container}\n`);
  const saved = { path: process.env.PATH, root: process.env.FAKE_XCRUN_ROOT };
  process.env.PATH = `${join(root, 'bin')}:${process.env.PATH ?? ''}`;
  process.env.FAKE_XCRUN_ROOT = root;
  return {
    root,
    container,
    calls: () => calls(join(root, 'xcrun.log')),
    reportContainer(path) {
      writeFileSync(join(root, 'container'), `${path}\n`);
    },
    restore() {
      process.env.PATH = saved.path;
      if (saved.root === undefined) delete process.env.FAKE_XCRUN_ROOT;
      else process.env.FAKE_XCRUN_ROOT = saved.root;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
