// Runs YAML tests through the real runner against a FakeDriver in a throwaway project root.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import type { QaEventBody } from '../../src/core/events.ts';
import { writeSecure } from '../../src/core/fsx.ts';
import type { Platform } from '../../src/core/types.ts';
import { acquireDisplayLock, markDisplayUnknown, readDisplayUnknown } from '../../src/drivers/index.ts';
import type { JevSetup, OcrFn } from '../../src/runner/engine.ts';
import { runSmoke, runTests, type RunnerDeps, type RunResult } from '../../src/runner/index.ts';
import type { FakeDriver } from './fake-driver.ts';
import { UNCALIBRATED } from './jev-stub.ts';

export const PROFILES: Record<string, string> = {
  tteonam: readFileSync(new URL('../../apps/tteonam.yaml', import.meta.url), 'utf8'),
  example: 'id: example\nname: Example Tickets\nandroid:\n  package: example.tickets\n',
  'web-demo': readFileSync(new URL('../../apps/web-demo.yaml', import.meta.url), 'utf8'),
};

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** Fresh project root with `apps/` profiles and the given files (paths relative to the root). */
export function tempRoot(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'qa-runner-'));
  roots.push(root);
  for (const [id, yaml] of Object.entries(PROFILES)) writeSecure(join(root, 'apps', `${id}.yaml`), yaml);
  for (const [rel, content] of Object.entries(files)) writeSecure(join(root, rel), content);
  return root;
}

/** This Mac's display state (the real lock and record files) kept in `dir`, never the host's `DISPLAY_DIR`. */
export function displayDeps(dir: string): Pick<RunnerDeps, 'acquireDisplayLock' | 'readDisplayUnknown' | 'markDisplayUnknown'> {
  return {
    acquireDisplayLock: () => acquireDisplayLock({ dir }),
    readDisplayUnknown: () => readDisplayUnknown({ dir }),
    markDisplayUnknown: (record) => markDisplayUnknown(record, { dir }),
  };
}

export function fakeDeps(root: string, driver: FakeDriver, jev: JevSetup = UNCALIBRATED): Partial<RunnerDeps> {
  return {
    createDriver: () => driver,
    pickDevice: async (platform: Platform) => ({ platform, id: driver.deviceId, name: 'Fake Pixel', osVersion: '17', state: 'booted', kind: 'emulator' }),
    acquireLock: () => ({ release: () => undefined }),
    ...displayDeps(join(root, '.qa', 'display')),
    jev: () => jev,
    ocr: null,
    clock: driver.clock,
    root,
    runsDir: join(root, '.qa', 'runs'),
    appsDir: join(root, 'apps'),
    inventoryDir: join(root, '.qa', 'inventory'),
    fixturesDir: join(root, 'fixtures'),
  };
}

export interface FakeRun {
  result: RunResult;
  root: string;
  events: QaEventBody[];
}

/** Writes `tests` (relative path → YAML) under a temp root and runs them (default on Android) with the fake driver. */
export async function runYaml(
  tests: Record<string, string>,
  driver: FakeDriver,
  opts: { jev?: JevSetup; files?: Record<string, string>; junit?: boolean; ocr?: OcrFn; platform?: Platform } = {},
): Promise<FakeRun> {
  const root = tempRoot({ ...opts.files, ...tests });
  const events: QaEventBody[] = [];
  const result = await runTests(
    { paths: Object.keys(tests).map((t) => join(root, t)), platform: opts.platform ?? 'android', junit: opts.junit, events: { emit: (e) => events.push(e) } },
    { ...fakeDeps(root, driver, opts.jev), ...(opts.ocr ? { ocr: opts.ocr } : {}) },
  );
  return { result, root, events };
}

export async function smokeFake(driver: FakeDriver, opts: { jev?: JevSetup; crawl?: boolean } = {}): Promise<FakeRun> {
  const root = tempRoot();
  const events: QaEventBody[] = [];
  const result = await runSmoke({ app: 'tteonam', platform: 'android', crawl: opts.crawl ? 'tabs' : undefined, events: { emit: (e) => events.push(e) } }, fakeDeps(root, driver, opts.jev));
  return { result, root, events };
}

export function readJsonl(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
