// Runner programmatic API (architecture §10): the CLI, the engine server and the planner all call these.
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PATHS } from '../core/config.ts';
import type { EventSink } from '../core/events.ts';
import { newRunId, sha256, writeJson, writeSecure } from '../core/fsx.ts';
import { PLATFORM_INFO, PLATFORMS } from '../core/platform.ts';
import type { DeviceInfo, Driver, Platform, ScreenModel, Verdict, WebTarget } from '../core/types.ts';
import { acquireDeviceLock, acquireDisplayLock, createDriver, failureStatus, markDisplayUnknown, pickDevice, readDisplayUnknown, type DisplayUnknown } from '../drivers/index.ts';
import { JevClient } from '../jev/client.ts';
import { loadJevConfig } from '../jev/config.ts';
import { loadCalibration } from '../jev/gates.ts';
import { buildScreenModel, candidateRow, normLabel, runOcr } from '../observe/index.ts';
import { OCR_HELPER } from '../ocr/ocr.ts';
import { exitCodeFor } from '../report/console.ts';
import { writeReports } from '../report/index.ts';
import { countQaStatuses, qaStatus, type QaStatus } from '../report/status.ts';
import { SUMMARY_SCHEMA, type RunSummary, type TestResult } from '../report/types.ts';
import { writeWebQa } from '../report/webqa.ts';
import { loadAppProfile, loadTests, type LoadedTest } from '../spec/load.ts';
import { profilePlatforms, type AppProfile } from '../spec/schema.ts';
import { appTarget, DEFAULT_TIMEOUT_MS, TestSession, type Clock, type JevSetup, type OcrFn } from './engine.ts';
import { writeInventory } from './inventory.ts';
import { EvidenceSanitizer } from './sanitize.ts';
import { assessRisk } from '../policy/risk.ts';
import { RunStore } from './store.ts';
import { countVerdicts } from './verdict.ts';

export type { DecisionSummary, StepResult, TestResult } from '../report/types.ts';
export { appTarget } from './engine.ts';

export interface RunResult {
  runId: string;
  runDir: string;
  counts: Record<Verdict, number>;
  qaCounts: Record<QaStatus, number>;
  tests: TestResult[];
  reportPath: string;
  junitPath: string | null;
  /** Run-relative `web-qa/plan.json` + `result.json` (check-run v1) when the run had website results, else empty. */
  webQa: string[];
}

export interface RunOptions {
  paths: string[];
  platform: Platform | 'all';
  deviceIds?: Partial<Record<Platform, string>>;
  tags?: string[];
  junit?: boolean;
  events?: EventSink;
  signal?: AbortSignal;
}

export interface SmokeOptions {
  app: string;
  platform: Platform;
  deviceId?: string;
  crawl?: 'tabs';
  events?: EventSink;
  signal?: AbortSignal;
}

export interface ScreenOptions {
  app: string;
  platform: Platform;
  deviceId?: string;
  events?: EventSink;
  signal?: AbortSignal;
}

/** Injection seam (tests, alternative device backends). Anything omitted uses the real implementation. */
export interface RunnerDeps {
  createDriver(platform: Platform, deviceId: string): Driver;
  pickDevice(platform: Platform, id?: string): Promise<DeviceInfo>;
  /** Throws when another live process holds the device. */
  acquireLock(deviceId: string): { release(): void };
  /**
   * The lock on this Mac's display, pointer and keyboard focus, taken by every qa process of this OS user (any
   * checkout) whose work opens a desktop browser: two browsers on one display take each other's input and focus.
   * Throws when another live process holds it.
   */
  acquireDisplayLock(): { release(): void };
  /** The host-wide record that a browser window may still be on the display (read under the display lock), or null. */
  readDisplayUnknown(): DisplayUnknown | null;
  /** Writes that record (throws when it cannot); only `qa setup --browsers` clears it. */
  markDisplayUnknown(record: DisplayUnknown): void;
  jev(): JevSetup;
  ocr: OcrFn | null;
  clock: Clock;
  root: string;
  runsDir: string;
  appsDir: string;
  inventoryDir: string;
  fixturesDir: string;
}

const realClock: Clock = { now: () => performance.now(), sleep: (ms) => delay(ms) };

/** Jev client + calibration from the environment; problems are carried as a reason (Jev steps then ERROR). */
function realJev(): JevSetup {
  let client: JevClient | null = null;
  let problem: string | null = null;
  try {
    client = new JevClient(loadJevConfig());
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err);
  }
  let calibration = null;
  try {
    calibration = loadCalibration(client?.model);
  } catch (err) {
    problem ??= `캘리브레이션 파일 오류: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { client, calibration, problem };
}

function resolveDeps(partial: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    createDriver: partial.createDriver ?? ((platform, id) => createDriver(platform, id)),
    pickDevice: partial.pickDevice ?? pickDevice,
    acquireLock: partial.acquireLock ?? ((id) => acquireDeviceLock(id)),
    acquireDisplayLock: partial.acquireDisplayLock ?? acquireDisplayLock,
    readDisplayUnknown: partial.readDisplayUnknown ?? readDisplayUnknown,
    markDisplayUnknown: partial.markDisplayUnknown ?? markDisplayUnknown,
    jev: partial.jev ?? realJev,
    ocr: partial.ocr !== undefined ? partial.ocr : existsSync(OCR_HELPER) ? runOcr : null,
    clock: partial.clock ?? realClock,
    root: partial.root ?? PATHS.root,
    runsDir: partial.runsDir ?? PATHS.runs,
    appsDir: partial.appsDir ?? PATHS.apps,
    inventoryDir: partial.inventoryDir ?? PATHS.inventory,
    fixturesDir: partial.fixturesDir ?? PATHS.fixtures,
  };
}

function posixRel(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A test × platform that could not run (spec error, no device, locked, session failure, cancelled), sanitized like a
 * session's result by `clean` (profile `redact` and the secrets it knows; a spec that did not load: built-ins only).
 */
function unrunResult(
  base: { id: string; name: string; file: string | null; app: string; test: LoadedTest | null },
  platform: Platform,
  verdict: Verdict,
  code: string,
  reason: string,
  device: DeviceInfo | null,
  clean: EvidenceSanitizer,
): TestResult {
  const spec = base.test?.spec;
  return clean.deep({
    id: base.id,
    name: base.name,
    file: base.file,
    app: base.app,
    platform,
    surface: base.test ? (base.test.profile.web ? 'web' : 'app') : null,
    deviceId: device?.id ?? null,
    deviceName: device?.name ?? null,
    verdict,
    code,
    qaStatus: qaStatus({ verdict, code }),
    reason,
    durationMs: 0,
    covers: spec?.covers ?? [],
    tags: spec?.tags ?? [],
    status: spec?.source?.status ?? null,
    plan: spec?.source?.plan ?? null,
    steps: [],
    warnings: [],
    health: [],
    logs: null,
    crash: [],
    evidenceDir: `${base.id}/${platform}`,
  });
}

/**
 * A lock released at most once: after its work, and again in the run's cleanup for work that never ran. The display
 * lock is dropped unreleased (held until the process exits) when its unknown state could not be recorded.
 */
interface Held {
  lock: { release(): void } | null;
}

interface Slot extends Held {
  platform: Platform;
  device: DeviceInfo | null;
  problem: { code: string; reason: string } | null;
}

function releaseHeld(held: Held): void {
  const lock = held.lock;
  held.lock = null;
  lock?.release();
}

/** Why no browser opens on this Mac's display while the host-wide record is there, and how the user clears it. */
function displayUnknownReason(unknown: DisplayUnknown): string {
  return `데스크톱 화면 상태를 알 수 없어 브라우저를 열지 않음 (${unknown.since}${unknown.runId ? ` 실행 ${unknown.runId}` : ''}: ${unknown.reason}) — 화면에 남은 브라우저 창을 닫은 뒤 qa setup --browsers로 해제하세요`;
}

/**
 * Records host-wide that a browser window may still be on this Mac's display (`reason` already sanitized) while the
 * display lock is still held: until `qa setup --browsers` clears it, no qa process of any checkout opens a browser
 * there. A record that cannot be written keeps the lock until this process exits (logged): releasing it would hand the
 * display on as if nothing were left.
 */
function recordDisplayUnknown(d: RunnerDeps, display: Held, sink: EventSink | undefined, reason: string, runId?: string): void {
  try {
    d.markDisplayUnknown({ since: new Date().toISOString(), reason, runId });
  } catch (err) {
    display.lock = null;
    sink?.emit({ type: 'log', level: 'error', source: 'runner', message: `데스크톱 화면 상태를 기록하지 못해 이 프로세스가 끝날 때까지 화면 잠금을 유지함 (${message(err)}) — 화면에 남은 브라우저 창을 닫으세요` });
  }
}

function isDesktop(platform: Platform): boolean {
  return PLATFORM_INFO[platform].host === 'desktop';
}

/**
 * Slots that run one after another. Desktop browsers share one lane (one display, pointer and keyboard focus);
 * `displayUnknown` is set once a browser window may have been left on that display, and nothing more runs there.
 */
interface Lane {
  desktop: boolean;
  slots: Slot[];
  displayUnknown: string | null;
}

/**
 * Picks and locks one device per platform, and the display (`acquireDisplayLock`) when any platform is a desktop
 * browser; failures become a per-platform problem (tests there ERROR): a display held elsewhere refuses every desktop
 * platform like a device in use, and one recorded as unknown (read under its lock) refuses them as `display_unknown`.
 */
async function claimDevices(d: RunnerDeps, platforms: readonly Platform[], ids: Partial<Record<Platform, string>> | undefined): Promise<{ slots: Map<Platform, Slot>; display: Held }> {
  const slots = new Map<Platform, Slot>();
  const display: Held = { lock: null };
  let displayProblem: Slot['problem'] = null;
  if (platforms.some(isDesktop)) {
    try {
      display.lock = d.acquireDisplayLock();
    } catch (err) {
      displayProblem = { code: 'device_locked', reason: `데스크톱 화면 사용 중: ${message(err)}` };
    }
    const unknown = display.lock ? d.readDisplayUnknown() : null;
    if (unknown) displayProblem = { code: 'display_unknown', reason: displayUnknownReason(unknown) };
  }
  for (const platform of platforms) {
    const slot: Slot = { platform, device: null, lock: null, problem: null };
    slots.set(platform, slot);
    try {
      slot.device = await d.pickDevice(platform, ids?.[platform]);
    } catch (err) {
      slot.problem = { code: 'no_device', reason: `${platform} 기기 없음: ${message(err)}` };
      continue;
    }
    if (displayProblem !== null && isDesktop(platform)) {
      slot.problem = displayProblem;
      continue;
    }
    try {
      slot.lock = d.acquireLock(slot.device.id);
    } catch (err) {
      slot.problem = { code: 'device_locked', reason: `기기 ${slot.device.id} 사용 중: ${message(err)}` };
    }
  }
  return { slots, display };
}

/** Identifies the tested website configuration for the web-qa export: a digest of every web profile in the run. */
function webBuildId(profiles: readonly AppProfile[]): string {
  const web = new Map(profiles.flatMap((p) => (p.web ? [[p.id, p.web] as const] : [])));
  const config = [...web].sort(([a], [b]) => a.localeCompare(b));
  return `config-${sha256(JSON.stringify(config)).slice(0, 16)}`;
}

function finishRun(
  store: RunStore,
  d: RunnerDeps,
  meta: {
    kind: RunSummary['kind'];
    startedAt: string;
    t0: number;
    platform: RunSummary['platform'];
    slots: Map<Platform, Slot>;
    junit: boolean;
    profiles: readonly AppProfile[];
  },
  tests: TestResult[],
): RunResult {
  const counts = countVerdicts(tests.map((t) => t.verdict));
  const qaCounts = countQaStatuses(tests.map((t) => t.qaStatus));
  const summary: RunSummary = {
    $schema: SUMMARY_SCHEMA,
    kind: meta.kind,
    runId: store.runId,
    startedAt: meta.startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(d.clock.now() - meta.t0),
    platform: meta.platform,
    devices: [...meta.slots.values()].flatMap((s) => (s.device ? [{ platform: s.platform, id: s.device.id, name: s.device.name }] : [])),
    counts,
    qaCounts,
    tests,
    reportPath: 'report.html',
    junitPath: meta.junit ? 'junit.xml' : null,
  };
  store.writeRecord('summary.json', summary, 'report');
  const { reportPath, junitPath } = writeReports(store.runDir, summary, { junit: meta.junit, root: d.root });
  const webQa = writeWebQa(store.runDir, summary, { buildId: webBuildId(meta.profiles), runnerExitCode: exitCodeFor(counts) });
  store.emit({ type: 'run.finished', runId: store.runId, counts, reportPath, junitPath });
  store.writeManifest();
  return { runId: store.runId, runDir: store.runDir, counts, qaCounts, tests, reportPath, junitPath, webQa };
}

/**
 * Runs tests (`*.e2e.yaml` files/dirs; default `tests/`) on the requested platforms (`all`: every platform each test's
 * profile runs on). One device (or desktop browser) per platform, locked for the run, and this Mac's display while its
 * desktop browsers run; platforms run concurrently, tests sequentially. Never throws for test failures — only for bad
 * input paths.
 */
export async function runTests(opts: RunOptions, deps?: Partial<RunnerDeps>): Promise<RunResult> {
  const d = resolveDeps(deps);
  const requested: readonly Platform[] = opts.platform === 'all' ? PLATFORMS : [opts.platform];
  const loaded = loadTests(opts.paths, { root: d.root, appsDir: d.appsDir, tags: opts.tags });
  const runId = newRunId();
  const store = new RunStore(join(d.runsDir, runId), runId, opts.events);
  const startedAt = new Date().toISOString();
  const t0 = d.clock.now();

  // test × platform plan
  const planned: { test: LoadedTest; platform: Platform }[] = [];
  const early: TestResult[] = [];
  const covered = new Set<Platform>();
  for (const test of loaded.tests) {
    const declared = test.spec.platforms;
    const available = profilePlatforms(test.profile);
    for (const p of available) covered.add(p);
    for (const platform of requested) {
      const base = { id: test.id, name: test.spec.name, file: posixRel(d.root, test.file), app: test.spec.app, test };
      if (declared && !declared.includes(platform)) continue;
      if (!available.includes(platform)) {
        if (declared) early.push(unrunResult(base, platform, 'ERROR', 'app_not_configured', `앱 프로필 ${test.spec.app}에 ${platform} 설정이 없습니다`, null, new EvidenceSanitizer(test.profile.redact)));
        continue;
      }
      planned.push({ test, platform });
    }
  }
  // A file that failed to load has no known profile: under `all` it is reported on the platforms the run covers.
  const errorPlatforms = opts.platform === 'all' && covered.size > 0 ? PLATFORMS.filter((p) => covered.has(p)) : requested;
  for (const e of loaded.errors) {
    for (const platform of errorPlatforms) {
      early.push(unrunResult({ id: e.id, name: e.id, file: posixRel(d.root, e.file), app: '', test: null }, platform, 'ERROR', 'spec_invalid', e.error.message, null, new EvidenceSanitizer([])));
    }
  }

  const { slots, display } = await claimDevices(
    d,
    requested.filter((p) => planned.some((x) => x.platform === p)),
    opts.deviceIds,
  );
  const results: TestResult[] = [];
  try {
    const jev = d.jev();
    store.emit({
      type: 'run.started',
      runId,
      runDir: store.runDir,
      tests: loaded.tests.map((t) => TestSession.announce(t, planned.filter((x) => x.test === t).map((x) => x.platform))),
      devices: [...slots.values()].flatMap((s) => (s.device ? [{ platform: s.platform, id: s.device.id, name: s.device.name }] : [])),
    });
    if (!d.ocr) store.emit({ type: 'log', level: 'warn', source: 'runner', message: 'OCR 도우미가 없어 OCR 없이 실행합니다 (qa setup으로 설치)' });
    for (const r of early) {
      store.emit({ type: 'test.finished', runId, testId: r.id, platform: r.platform, verdict: r.verdict, reason: r.reason, durationMs: 0 });
    }

    const runSlot = async (slot: Slot, lane: Lane): Promise<TestResult[]> => {
      const mine = planned.filter((x) => x.platform === slot.platform);
      const out: TestResult[] = [];
      const skip = (test: LoadedTest, verdict: Verdict, code: string, reason: string) => {
        const base = { id: test.id, name: test.spec.name, file: posixRel(d.root, test.file), app: test.spec.app, test };
        const r = unrunResult(base, slot.platform, verdict, code, reason, slot.device, new EvidenceSanitizer(test.profile.redact));
        store.emit({ type: 'test.finished', runId, testId: r.id, platform: r.platform, verdict, reason: r.reason, durationMs: 0 });
        out.push(r);
      };
      // A browser window of this lane may still be on the display: its input and focus would reach the wrong window.
      // Recorded host-wide before the display lock goes, so later runs of any checkout do not open a browser either.
      const loseDisplay = (clean: EvidenceSanitizer, what: string, err: unknown) => {
        const cause = clean.text(`${PLATFORM_INFO[slot.platform].label} ${what} (${message(err)})`);
        lane.displayUnknown = `데스크톱 화면 상태를 알 수 없어 남은 브라우저 테스트를 실행하지 않음: ${cause}`;
        store.emit({ type: 'log', level: 'error', source: 'runner', message: lane.displayUnknown });
        recordDisplayUnknown(d, display, store, cause, runId);
      };
      if (slot.problem || !slot.device) {
        for (const { test } of mine) skip(test, 'ERROR', slot.problem?.code ?? 'no_device', slot.problem?.reason ?? '기기 없음');
        return out;
      }
      const device = slot.device;
      const driver = d.createDriver(slot.platform, device.id);
      // One session per app: capabilities are app-specific.
      const apps = [...new Set(mine.map((x) => x.test.spec.app))];
      for (const app of apps) {
        const group = mine.filter((x) => x.test.spec.app === app);
        if (lane.displayUnknown !== null) {
          for (const { test } of group) skip(test, 'ERROR', 'display_unknown', lane.displayUnknown);
          continue;
        }
        const profile = group[0]!.test.profile;
        const target = appTarget(profile, slot.platform)!;
        try {
          await driver.open(target);
        } catch (err) {
          for (const { test } of group) skip(test, 'ERROR', 'session_failed', `자동화 세션을 열 수 없음: ${message(err)}`);
          if (lane.desktop && failureStatus(err) !== 'rejected') loseDisplay(new EvidenceSanitizer(profile.redact), '세션 시작이 확인되지 않은 채 실패해 창이 남았을 수 있음', err);
          continue;
        }
        try {
          for (const { test } of group) {
            if (opts.signal?.aborted) {
              skip(test, 'SKIPPED', 'cancelled', '실행이 취소되어 건너뜀');
              continue;
            }
            const session = new TestSession(
              { runId, store, clean: new EvidenceSanitizer(test.profile.redact), driver, device, clock: d.clock, jev, ocr: d.ocr, relFile: posixRel(d.root, test.file), signal: opts.signal },
              test,
              slot.platform,
              target,
            );
            out.push(await session.run());
          }
        } finally {
          try {
            await driver.close();
          } catch (err) {
            // A device session ends with its driver; a desktop browser whose end is unconfirmed may still be on screen.
            if (lane.desktop) loseDisplay(new EvidenceSanitizer(profile.redact), '세션 종료를 확인하지 못함', err);
          }
        }
      }
      return out;
    };
    // Desktop browsers share this Mac's display, pointer and keyboard focus, so they run one after another (measured:
    // Safari's clicks had no effect while a Chrome window was in front of it) under the display lock, which keeps other
    // qa processes' browsers off the display until this lane ends (and after it, while its state is recorded as
    // unknown); devices run in parallel.
    const lanes = new Map<string, Lane>();
    for (const slot of slots.values()) {
      const desktop = isDesktop(slot.platform);
      const key = desktop ? 'desktop' : slot.platform;
      const lane = lanes.get(key) ?? { desktop, slots: [], displayUnknown: null };
      lane.slots.push(slot);
      lanes.set(key, lane);
    }
    // Every lane settles before the locks are released: a lane that throws does not free a device another lane still uses.
    const settled = await Promise.allSettled(
      [...lanes.values()].map(async (lane) => {
        const out: TestResult[] = [];
        for (const slot of lane.slots) {
          out.push(...(await runSlot(slot, lane)));
          releaseHeld(slot);
        }
        if (lane.desktop) releaseHeld(display);
        return out;
      }),
    );
    for (const lane of settled) {
      if (lane.status === 'rejected') throw lane.reason;
      results.push(...lane.value);
    }
  } finally {
    for (const slot of slots.values()) releaseHeld(slot);
    releaseHeld(display);
  }

  const byKey = new Map(results.map((r) => [`${r.id} ${r.platform}`, r]));
  const ordered: TestResult[] = [];
  for (const test of loaded.tests) for (const p of requested) {
    const r = byKey.get(`${test.id} ${p}`);
    if (r) ordered.push(r);
  }
  ordered.push(...early);
  const profiles = loaded.tests.map((t) => t.profile);
  return finishRun(store, d, { kind: 'run', startedAt, t0, platform: opts.platform, slots, junit: opts.junit ?? false, profiles }, ordered);
}

/** Smoke-test pseudo spec: relaunch, no DSL steps (the session drives smoke itself). */
function smokeTest(profile: AppProfile): LoadedTest {
  return {
    file: join(PATHS.root, 'smoke'),
    id: 'smoke',
    spec: { name: `스모크: ${profile.name}`, app: profile.id, start: 'launch', reset: 'relaunch', steps: [] },
    profile,
    flows: new Map(),
  };
}

/**
 * Observe-only smoke on one platform: launch → settle → health (incl. blank) → screenshot → inventory. `crawl:'tabs'`
 * visits role-identified tab bar items only (risk-filtered) and returns to the first tab. Jev is a reference column.
 * A desktop browser whose start or end is unconfirmed may still be on the display: the smoke is then ERROR
 * `display_unknown` (its own result kept in the reason) and the display is recorded as unknown, so no qa process opens
 * another browser until `qa setup --browsers` clears it. `test.finished` carries that final verdict.
 */
export async function runSmoke(opts: SmokeOptions, deps?: Partial<RunnerDeps>): Promise<RunResult> {
  const d = resolveDeps(deps);
  const profile = loadAppProfile(opts.app, d.appsDir);
  // Every record of the smoke run, in the session or around it, passes one sanitizer (built before anything is written).
  const clean = new EvidenceSanitizer(profile.redact);
  const target = appTarget(profile, opts.platform);
  if (!target) throw new Error(`앱 프로필 ${opts.app}에 ${opts.platform} 설정이 없습니다`);
  const runId = newRunId();
  const store = new RunStore(join(d.runsDir, runId), runId, opts.events);
  const startedAt = new Date().toISOString();
  const t0 = d.clock.now();
  const test = smokeTest(profile);
  const { slots, display } = await claimDevices(d, [opts.platform], { [opts.platform]: opts.deviceId });
  const slot = slots.get(opts.platform)!;
  const desktop = isDesktop(opts.platform);
  let result: TestResult;
  try {
    store.emit({
      type: 'run.started',
      runId,
      runDir: store.runDir,
      tests: [clean.deep({ id: test.id, name: test.spec.name, platforms: [opts.platform], steps: ['앱 시작: relaunch', '화면 점검: launch', ...(opts.crawl ? ['탭 순회'] : [])] })],
      devices: slot.device ? [{ platform: opts.platform, id: slot.device.id, name: slot.device.name }] : [],
    });
    const base = { id: test.id, name: test.spec.name, file: null, app: profile.id, test };
    if (slot.problem || !slot.device) {
      result = unrunResult(base, opts.platform, 'ERROR', slot.problem?.code ?? 'no_device', slot.problem?.reason ?? '기기 없음', null, clean);
    } else {
      const driver = d.createDriver(opts.platform, slot.device.id);
      let opened = false;
      let lost: string | null = null;
      try {
        await driver.open(target);
        opened = true;
        try {
          const session = new TestSession(
            { runId, store, clean, driver, device: slot.device, clock: d.clock, jev: d.jev(), ocr: d.ocr, relFile: null, signal: opts.signal },
            test,
            opts.platform,
            target,
          );
          result = await session.runSmoke({ crawl: opts.crawl === 'tabs', inventoryDir: d.inventoryDir });
        } finally {
          await driver.close().catch((err: unknown) => {
            // A device session ends with its driver; a desktop browser whose end is unconfirmed may still be on screen.
            if (desktop) lost = `세션 종료를 확인하지 못함 (${message(err)})`;
          });
        }
      } catch (err) {
        result = unrunResult(base, opts.platform, 'ERROR', 'session_failed', `자동화 세션을 열 수 없음: ${message(err)}`, slot.device, clean);
        if (desktop && !opened && failureStatus(err) !== 'rejected') lost = `세션 시작이 확인되지 않은 채 실패해 창이 남았을 수 있음 (${message(err)})`;
      }
      if (lost !== null) {
        const cause = clean.text(`${PLATFORM_INFO[opts.platform].label} ${lost}`);
        const reason = `데스크톱 화면 상태를 알 수 없음: ${cause}`;
        store.emit({ type: 'log', level: 'error', source: 'runner', message: reason });
        recordDisplayUnknown(d, display, store, cause, runId);
        const own = result.verdict === 'PASS' ? '' : `; 스모크 결과 ${result.verdict}${result.code ? ` ${result.code}` : ''}: ${result.reason}`;
        result = { ...result, verdict: 'ERROR', code: 'display_unknown', qaStatus: qaStatus({ verdict: 'ERROR', code: 'display_unknown' }), reason: `${reason}${own}` };
      }
    }
  } finally {
    releaseHeld(slot);
    releaseHeld(display);
  }
  store.emit({ type: 'test.finished', runId, testId: result.id, platform: result.platform, verdict: result.verdict, reason: result.reason, durationMs: result.durationMs });
  return finishRun(store, d, { kind: 'smoke', startedAt, t0, platform: opts.platform, slots, junit: false, profiles: [profile] }, [result]);
}

/**
 * A fresh browser session shows a blank tab: opens the start URL and waits (≤ the default step timeout) until the page
 * shows content, so inspect/capture observe the site rather than about:blank.
 */
async function openStartPage(driver: Driver, target: WebTarget, d: RunnerDeps, profile: AppProfile): Promise<void> {
  const opened = await driver.openUrl(target, target.url);
  if (opened.status !== 'completed') throw new Error(`시작 페이지를 열 수 없음(${opened.status}): ${opened.error ?? target.url}`);
  const deadline = d.clock.now() + DEFAULT_TIMEOUT_MS;
  for (;;) {
    const model = buildScreenModel(await driver.snapshot({ screenshot: false }), { volatile: profile.volatile });
    if (model.candidates.length > 0 || model.texts.length > 0) return;
    if (d.clock.now() >= deadline) throw new Error(`시작 페이지가 ${DEFAULT_TIMEOUT_MS}ms 안에 내용을 표시하지 않음: ${target.url}`);
    await d.clock.sleep(250);
  }
}

/**
 * Opens a session on the platform's device (locked; a desktop browser also locks this Mac's display first, see
 * `RunnerDeps.acquireDisplayLock`) without launching an app — a website is opened at its start URL — runs `use`, then
 * cleans up. A desktop browser is refused while the display is recorded as unknown; one whose start or end is
 * unconfirmed records that (its window may still be on the display) and throws.
 */
async function withScreen<T>(opts: ScreenOptions, d: RunnerDeps, use: (driver: Driver, device: DeviceInfo, profile: AppProfile) => Promise<T>): Promise<T> {
  const profile = loadAppProfile(opts.app, d.appsDir);
  const target = appTarget(profile, opts.platform);
  if (!target) throw new Error(`앱 프로필 ${opts.app}에 ${opts.platform} 설정이 없습니다`);
  const desktop = isDesktop(opts.platform);
  const device = await d.pickDevice(opts.platform, opts.deviceId);
  const display: Held = { lock: desktop ? d.acquireDisplayLock() : null };
  let lock: { release(): void } | null = null;
  // A browser window may be left on the display: recorded before the display lock goes, then thrown.
  const lose = (what: string, err: unknown): Error => {
    const cause = new EvidenceSanitizer(profile.redact).text(`${PLATFORM_INFO[opts.platform].label} ${what} (${message(err)})`);
    recordDisplayUnknown(d, display, opts.events, cause);
    return new Error(`데스크톱 화면 상태를 알 수 없음: ${cause}`, { cause: err });
  };
  try {
    const unknown = desktop ? d.readDisplayUnknown() : null;
    if (unknown) throw new Error(displayUnknownReason(unknown));
    lock = d.acquireLock(device.id);
    const driver = d.createDriver(opts.platform, device.id);
    await driver.open(target).catch((err: unknown) => {
      throw desktop && failureStatus(err) !== 'rejected' ? lose('세션 시작이 확인되지 않은 채 실패해 창이 남았을 수 있음', err) : err;
    });
    try {
      if (target.kind === 'web') await openStartPage(driver, target, d, profile);
      opts.signal?.throwIfAborted();
      return await use(driver, device, profile);
    } finally {
      await driver.close().catch((err: unknown) => {
        // A device session ends with its driver; a desktop browser whose end is unconfirmed may still be on screen.
        if (desktop) throw lose('세션 종료를 확인하지 못함', err);
      });
    }
  } finally {
    lock?.release();
    releaseHeld(display);
  }
}

export interface InspectResult {
  table: string;
  model: ScreenModel;
}

/** Candidate table of the current screen: Observe's row format plus risk and fast-path uniqueness columns. */
export function renderInspectTable(model: ScreenModel, profile: AppProfile | null): string {
  const counts = new Map<string, number>();
  for (const c of model.candidates) counts.set(normLabel(c.name), (counts.get(normLabel(c.name)) ?? 0) + 1);
  const rows = model.candidates.map((c) => {
    const risk = c.actionable ? assessRisk(c, model, profile) : null;
    const n = counts.get(normLabel(c.name)) ?? 0;
    const unique = !c.name ? '라벨 없음' : n === 1 ? '유일' : `중복 ${n}`;
    return `${candidateRow(c)} | ${risk ? (risk.risky ? `위험: ${risk.reasons.join(', ')}` : '안전') : '-'} | ${unique} | ${c.tapPoint.x},${c.tapPoint.y}`;
  });
  const s = model.snapshot;
  return [
    '키 | 역할 | 이름 | 상태 | 영역 | 위험 | fast path | 탭 지점',
    ...rows,
    `후보 ${model.candidates.length}개 · 가려진 노드 ${model.occludedNodeIds.length}개 · 텍스트 ${model.texts.length}줄${model.sparse ? ' · 희소(OCR 대상)' : ''}${model.overflow ? ' · 254개 초과' : ''}${s.depthCapped ? ' · 트리 깊이 상한 도달' : ''} · 포그라운드 ${s.foregroundApp ?? '알 수 없음'}${s.pageUrl ? ` · 페이지 ${s.pageUrl}` : ''}`,
  ].join('\n');
}

export async function inspectScreen(opts: ScreenOptions, deps?: Partial<RunnerDeps>): Promise<InspectResult> {
  const d = resolveDeps(deps);
  return withScreen(opts, d, async (driver, _device, profile) => {
    const snap = await driver.snapshot({ screenshot: false });
    const model = buildScreenModel(snap, { volatile: profile.volatile });
    return { table: renderInspectTable(model, profile), model };
  });
}

export interface CaptureResult {
  xml: string;
  png: string;
  meta: string;
  inventory: string;
}

/**
 * Saves the current screen as a fixture triplet `fixtures/<platform>/<app>/<name>.{xml,png,meta.json}` + inventory.
 * The XML and inventory pass the evidence sanitizer (password values, profile `redact`, built-in PII).
 */
export async function captureScreen(opts: ScreenOptions & { name: string }, deps?: Partial<RunnerDeps>): Promise<CaptureResult> {
  if (!/^[\w.-]+$/.test(opts.name)) throw new Error(`캡처 이름은 영문·숫자·._- 만 허용됩니다: ${opts.name}`);
  const d = resolveDeps(deps);
  return withScreen(opts, d, async (driver, device, profile) => {
    const snap = await driver.snapshot({ screenshot: true });
    const png = snap.screenshotPng ?? (await driver.screenshot());
    const base = join(d.fixturesDir, opts.platform, opts.app, opts.name);
    const clean = new EvidenceSanitizer(profile.redact);
    clean.observe(snap);
    writeSecure(`${base}.xml`, clean.source(snap.rawSource));
    writeSecure(`${base}.png`, png);
    writeJson(`${base}.meta.json`, {
      platform: opts.platform,
      app: opts.app,
      name: opts.name,
      windowRect: snap.screen,
      capturedAt: snap.takenAt,
      device: `${device.id} (${device.name}, ${device.osVersion})`,
      source: 'app-qa capture (Appium /source)',
      foregroundApp: snap.foregroundApp,
      surface: snap.surface,
      pageUrl: snap.pageUrl === null ? null : clean.text(snap.pageUrl),
      keyboardShown: snap.keyboardShown,
      maxDepth: snap.maxDepth,
      depthCapped: snap.depthCapped,
    });
    const model = buildScreenModel(snap, { volatile: profile.volatile });
    const inventory = writeInventory(d.inventoryDir, opts.app, opts.platform, opts.name, model, 'capture', clean);
    opts.events?.emit({ type: 'log', level: 'info', source: 'capture', message: `화면 캡처 저장: ${relative(d.root, base)} (후보 ${model.candidates.length}개)` });
    return { xml: `${base}.xml`, png: `${base}.png`, meta: `${base}.meta.json`, inventory };
  });
}
