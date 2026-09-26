// App context for generation: the app profile, the real on-screen strings per screen, and declared `${VAR}` names.
// Screens come from `.qa/inventory/<app>/**` (qa capture / qa smoke --crawl tabs); when that is empty, from the
// fixtures `fixtures/<platform>/<app>/*.xml` through Observe's screen model (same candidates/texts the runner sees).
// Only the profile's platforms count: a website's desktop/mobile browsers, an app's configured android/ios.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { PATHS } from '../core/config.ts';
import { PLATFORMS } from '../core/platform.ts';
import type { Platform, Snapshot } from '../core/types.ts';
import { buildScreenModel, SOURCE_PARSERS } from '../observe/index.ts';
import { loadAppProfile } from '../spec/load.ts';
import { profilePlatforms, type AppProfile } from '../spec/schema.ts';

export interface ScreenInfo {
  platform: Platform;
  name: string;
  source: 'inventory' | 'fixture';
  candidates: { role: string; name: string; state: string[]; actionable: boolean }[];
  texts: string[];
}

export interface AppContext {
  profile: AppProfile;
  screens: ScreenInfo[];
  /** `${NAME}` placeholders a generated test may use (declared in `.env.example`). */
  envNames: ReadonlySet<string>;
  /** Unreadable inventory/fixture files (reported as warnings, never fatal). */
  warnings: string[];
}

export interface ContextDirs {
  apps: string;
  inventory: string;
  fixtures: string;
  envExample: string;
}

export const DEFAULT_CONTEXT_DIRS: ContextDirs = {
  apps: PATHS.apps,
  inventory: PATHS.inventory,
  fixtures: PATHS.fixtures,
  envExample: join(PATHS.root, '.env.example'),
};

/** Lenient reader for `app-qa/inventory/v1` files (extra keys ignored). */
const InventoryFile = z.object({
  platform: z.enum(PLATFORMS).optional(),
  name: z.string().optional(),
  texts: z.array(z.string()).default([]),
  candidates: z
    .array(z.object({ role: z.string().default('other'), name: z.string(), state: z.array(z.string()).default([]), actionable: z.boolean().default(false) }))
    .default([]),
});

export function loadAppContext(app: string, dirs: ContextDirs = DEFAULT_CONTEXT_DIRS): AppContext {
  const profile = loadAppProfile(app, dirs.apps);
  const platforms = profilePlatforms(profile);
  const warnings: string[] = [];
  let screens = readInventory(app, dirs.inventory, platforms, warnings);
  if (!screens.length) screens = readFixtures(app, dirs.fixtures, profile, platforms, warnings);
  screens.sort((a, b) => PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform) || a.name.localeCompare(b.name));
  return { profile, screens, envNames: declaredEnvNames(dirs.envExample), warnings };
}

function readInventory(app: string, dir: string, platforms: readonly Platform[], warnings: string[]): ScreenInfo[] {
  const root = join(dir, app);
  if (!existsSync(root)) return [];
  const screens: ScreenInfo[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = join(entry.parentPath, entry.name);
    try {
      const inv = InventoryFile.parse(JSON.parse(readFileSync(file, 'utf8')));
      const platform = inv.platform ?? PLATFORMS.find((p) => p === basename(entry.parentPath));
      if (!platform) throw new Error('platform 없음');
      if (!platforms.includes(platform)) throw new Error(`앱 프로필의 플랫폼(${platforms.join(', ')})이 아님: ${platform}`);
      screens.push({ platform, name: inv.name ?? basename(entry.name, '.json'), source: 'inventory', candidates: inv.candidates, texts: inv.texts });
    } catch (err) {
      warnings.push(`인벤토리 파일을 건너뜀: ${file}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  return screens;
}

function readFixtures(app: string, dir: string, profile: AppProfile, platforms: readonly Platform[], warnings: string[]): ScreenInfo[] {
  const screens: ScreenInfo[] = [];
  for (const platform of platforms) {
    const base = join(dir, platform, app);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).filter((f) => f.endsWith('.xml')).sort()) {
      const stem = basename(name, '.xml');
      try {
        const xml = readFileSync(join(base, name), 'utf8');
        const meta = JSON.parse(readFileSync(join(base, `${stem}.meta.json`), 'utf8')) as { windowRect: Snapshot['screen']; capturedAt?: string; pageUrl?: string | null };
        const model = buildScreenModel(
          {
            platform,
            // The profile decides the surface: on android/ios a website fixture is the browser app's tree.
            surface: profile.web ? 'web' : 'app',
            takenAt: meta.capturedAt ?? '',
            screen: meta.windowRect,
            nodes: SOURCE_PARSERS[platform](xml, meta.windowRect),
            rawSource: xml,
            screenshotPng: null,
            foregroundApp: null,
            pageUrl: meta.pageUrl ?? null,
            keyboardShown: false,
            maxDepth: null,
            depthCapped: false,
          },
          { volatile: profile.volatile },
        );
        screens.push({
          platform,
          name: stem,
          source: 'fixture',
          candidates: model.candidates.map((c) => ({ role: c.role, name: c.name, state: c.state, actionable: c.actionable })),
          texts: model.texts,
        });
      } catch (err) {
        warnings.push(`fixture 화면을 건너뜀: ${platform}/${app}/${stem}: ${(err as Error).message.split('\n')[0]}`);
      }
    }
  }
  return screens;
}

/**
 * App variables declared in `.env.example` (`NAME=` or commented `# NAME=`). Tool settings (Jev key, LLM choice, SDK
 * paths) are never test inputs: typing `${TYPESAFE_API_KEY}` into an app would leak it.
 */
export function declaredEnvNames(file: string): Set<string> {
  const names = new Set<string>();
  if (!existsSync(file)) return names;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*#?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && !/^(TYPESAFE_|QA_|ANDROID_|APPIUM_)/.test(m[1]!)) names.add(m[1]!);
  }
  return names;
}
