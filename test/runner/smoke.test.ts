import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Snapshot } from '../../src/core/types.ts';
import type { InventoryFile } from '../../src/runner/inventory.ts';
import { FakeDriver, fixtureSnapshot, hits } from '../helpers/fake-driver.ts';
import { jevStub, noul } from '../helpers/jev-stub.ts';
import { smokeFake } from '../helpers/run.ts';

const APP = 'kr.tteonam.app';
const screen = (name: string, patch?: [string, string][]): Snapshot => fixtureSnapshot('android', 'tteonam', name, { foreground: APP, patch });

describe('smoke', () => {
  it('observe-only smoke relaunches, checks health, saves the screenshot and inventory; Jev is reference only', async () => {
    const driver = new FakeDriver(screen('launch'));
    const jev = jevStub(() => noul(0.97)); // Jev claims "error/blank" — must not change the verdict
    const { result, root } = await smokeFake(driver, { jev: jev.setup });
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'PASS', t.reason);
    assert.deepEqual(driver.calls.filter((c) => ['terminate', 'launch', 'tap'].includes(c.method)).map((c) => c.method), ['terminate', 'launch']);
    const check = t.steps[1]!;
    assert.ok(check.decisions.every((d) => d.reference === true));
    assert.ok(check.after && existsSync(join(result.runDir, check.after)));
    const inv = JSON.parse(readFileSync(join(root, '.qa/inventory/tteonam/android/launch.json'), 'utf8')) as InventoryFile;
    assert.ok(inv.candidates.some((c) => c.name === '출국장' && c.role === 'tab'));
    assert.ok(inv.texts.includes('출발했어요'));
  });

  it('fails on a RedBox screen', async () => {
    const driver = new FakeDriver(fixtureSnapshot('android', 'ticketestimate', 'launch'));
    const { result } = await smokeFake(driver);
    assert.equal(result.tests[0]!.verdict, 'FAIL');
    assert.equal(result.tests[0]!.code, 'rn_redbox');
  });

  it('crawls only the tab bar, writes one inventory per tab and returns to the first tab', async () => {
    const launch = screen('launch');
    const guide = screen('launch', [['text="떠남"', 'text="안내 페이지"']]);
    const byTab: Record<string, () => Snapshot> = {
      홈: () => launch,
      출국장: () => screen('tab-departures'),
      주차: () => screen('tab-parking'),
      안내: () => guide,
    };
    const driver = new FakeDriver(launch);
    driver.onTap = (p, d) => {
      const tab = Object.keys(byTab).find((name) => hits(d.screen, name, p) && p.y > 2100);
      return tab ? byTab[tab]!() : null;
    };
    const { result, root } = await smokeFake(driver, { crawl: true });
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'PASS', t.reason);
    const tapped = driver.called('tap').map((c) => Object.keys(byTab).find((name) => hits(launch, name, c.args[0] as { x: number; y: number })));
    assert.deepEqual(tapped, ['출국장', '주차', '안내', '홈'], 'visits unselected tabs left→right, then returns to the first');
    const files = readdirSync(join(root, '.qa/inventory/tteonam/android')).sort();
    assert.deepEqual(files, ['launch.json', 'tab-안내.json', 'tab-주차.json', 'tab-출국장.json', 'tab-홈.json'].sort());
  });
});
