// Fixture loading shared by observe tests: fixtures/<platform>/<app>/<name>.{xml,meta.json} → Snapshot / ScreenModel.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../../src/core/config.ts';
import type { Platform, Rect, ScreenModel, Snapshot } from '../../src/core/types.ts';
import { buildScreenModel, parseAndroidSource, parseIosSource } from '../../src/observe/index.ts';
import type { ScreenModelOptions } from '../../src/observe/index.ts';

export function fixtureXml(name: string): string {
  return readFileSync(join(PATHS.fixtures, `${name}.xml`), 'utf8');
}

export function fixtureScreen(name: string): Rect {
  const meta = JSON.parse(readFileSync(join(PATHS.fixtures, `${name}.meta.json`), 'utf8')) as { windowRect: Rect };
  return { x: 0, y: 0, width: meta.windowRect.width, height: meta.windowRect.height };
}

export function snapshotOf(platform: Platform, xml: string, screen: Rect): Snapshot {
  const nodes = platform === 'android' ? parseAndroidSource(xml, screen) : parseIosSource(xml, screen);
  return {
    platform,
    takenAt: '2026-09-26T00:00:00.000Z',
    screen,
    nodes,
    rawSource: xml,
    screenshotPng: null,
    foregroundApp: null,
    keyboardShown: false,
    maxDepth: Math.max(0, ...nodes.map((n) => n.id.split('.').length - 1)),
    depthCapped: false,
  };
}

/** `name` like "android/tteonam/my-flight-sheet"; `edit` rewrites the XML before parsing. */
export function loadSnapshot(name: string, edit?: (xml: string) => string): Snapshot {
  const xml = fixtureXml(name);
  return snapshotOf(name.split('/')[0] as Platform, edit ? edit(xml) : xml, fixtureScreen(name));
}

export function loadModel(name: string, opts?: ScreenModelOptions, edit?: (xml: string) => string): ScreenModel {
  return buildScreenModel(loadSnapshot(name, edit), opts);
}

export const ANDROID_SCREEN: Rect = { x: 0, y: 0, width: 1080, height: 2400 };

/** Minimal UiAutomator2 element for synthetic sources. */
export function uiaNode(attrs: Record<string, string>, children = ''): string {
  const defaults: Record<string, string> = {
    class: 'android.view.View',
    package: 'com.example',
    text: '',
    clickable: 'false',
    enabled: 'true',
    focusable: 'false',
    displayed: 'true',
    'drawing-order': '0',
    'window-id': '1',
  };
  const all = { ...defaults, ...attrs };
  const a = Object.entries(all)
    .map(([k, v]) => `${k}="${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`)
    .join(' ');
  return children ? `<${all.class} ${a}>${children}</${all.class}>` : `<${all.class} ${a}/>`;
}

export function uiaSource(body: string): string {
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy index="0" class="hierarchy" rotation="0" width="1080" height="2400">${body}</hierarchy>`;
}
