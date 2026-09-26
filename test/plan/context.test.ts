import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { PATHS } from '../../src/core/config.ts';
import { loadAppContext, type AppContext } from '../../src/plan/context.ts';
import { buildPrompt } from '../../src/plan/prompt.ts';
import { loadAppProfile } from '../../src/spec/load.ts';
import { tempDir } from './helpers.ts';

function webDemoContext(): AppContext {
  const empty = tempDir();
  return loadAppContext('web-demo', { apps: PATHS.apps, inventory: empty, fixtures: PATHS.fixtures, envExample: join(empty, 'none') });
}

describe('planner context for a website profile', () => {
  test('fixtures of every web platform are read with the right parser; mobile screens exclude the browser UI', () => {
    const ctx = webDemoContext();
    assert.deepEqual(ctx.warnings, []);
    assert.deepEqual([...new Set(ctx.screens.map((s) => s.platform))], ['android', 'ios', 'desktop-chrome']);
    const desktop = ctx.screens.find((s) => s.platform === 'desktop-chrome' && s.name === 'index')!;
    assert.ok(desktop.candidates.some((c) => c.role === 'button' && c.name === '검색'));
    assert.ok(desktop.candidates.some((c) => c.role === 'input' && c.name === '상품 검색'));
    const android = ctx.screens.find((s) => s.platform === 'android' && s.name === 'index')!;
    assert.ok(android.texts.includes('상품 3개'));
    for (const chrome of ['localhost:4173', 'Chrome 맞춤설정 및 제어']) {
      assert.ok(!android.texts.includes(chrome) && !android.candidates.some((c) => c.name.includes(chrome)), chrome);
    }
  });

  test('inventory of a platform the profile does not run on is skipped with a warning', () => {
    const dir = tempDir();
    const apps = join(dir, 'apps');
    const inventory = join(dir, 'inventory', 'shop');
    for (const d of [apps, join(inventory, 'desktop-safari'), join(inventory, 'android')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(apps, 'shop.yaml'), JSON.stringify({ id: 'shop', name: '상점', web: { url: 'https://shop.example/', platforms: ['desktop-safari'] } }));
    const screen = { texts: ['상품 3개'], candidates: [{ role: 'button', name: '검색', actionable: true }] };
    writeFileSync(join(inventory, 'desktop-safari', 'home.json'), JSON.stringify(screen));
    writeFileSync(join(inventory, 'android', 'home.json'), JSON.stringify(screen));
    const ctx = loadAppContext('shop', { apps, inventory: join(dir, 'inventory'), fixtures: join(dir, 'none'), envExample: join(dir, 'none') });
    assert.deepEqual(
      ctx.screens.map((s) => `${s.platform}/${s.name}`),
      ['desktop-safari/home'],
    );
    assert.equal(ctx.warnings.length, 1);
    assert.match(ctx.warnings[0]!, /android.*앱 프로필의 플랫폼\(desktop-safari\)이 아님/);
  });
});

describe('generation prompt', () => {
  test('a website prompt names the start URL, allowed origins and platforms, and forbids leaving the origins', () => {
    const prompt = buildPrompt(webDemoContext(), [], {});
    assert.match(prompt, /for a mobile app or a website/);
    assert.match(prompt, /^id: web-demo · .* · kind: website · url: http:\/\/localhost:4173\/ · ORIGINS: http:\/\/localhost:4173 · platforms: android, ios, desktop-chrome, desktop-safari$/m);
    assert.match(prompt, /# WEBSITE RULES[\s\S]*never tap a link or button that leaves them[\s\S]*needs_approval: 허용 origin 밖 이동/);
    assert.match(prompt, /## desktop-chrome\/index/);
  });

  test('an app prompt keeps the app line and has no website rules', () => {
    const ctx: AppContext = { profile: loadAppProfile('tteonam'), screens: [], envNames: new Set(), warnings: [] };
    const prompt = buildPrompt(ctx, [], {});
    assert.match(prompt, /^id: tteonam · .* · kind: mobile app · platforms: android \(/m);
    assert.doesNotMatch(prompt, /WEBSITE RULES|ORIGINS/);
  });
});
