// Multi-platform smoke loop shared by `qa smoke` and the engine server. Runner-free (the smoke itself is passed in), so
// `qa serve` keeps importing the runner lazily.
import { PLATFORM_INFO } from '../core/platform.ts';
import type { Platform } from '../core/types.ts';

/** One platform of a multi-platform smoke: its run, or why it was not started (counted as ERROR `display_unknown`). */
export type PlatformSmoke<R> = { platform: Platform; result: R; notRun: null } | { platform: Platform; result: null; notRun: string };

/**
 * Smokes `platforms` one after another. Once a desktop smoke ends with `display_unknown` (its browser window may still
 * be on the display), the remaining desktop platforms are never opened: input and focus would reach the wrong window.
 * Device platforms still run.
 */
export async function* smokeEach<R extends { tests: readonly { code: string | null }[] }>(
  platforms: readonly Platform[],
  run: (platform: Platform) => Promise<R>,
): AsyncGenerator<PlatformSmoke<R>> {
  let displayLost: Platform | null = null;
  for (const platform of platforms) {
    const desktop = PLATFORM_INFO[platform].host === 'desktop';
    if (desktop && displayLost !== null) {
      yield { platform, result: null, notRun: `${PLATFORM_INFO[displayLost].label} 스모크 뒤 데스크톱 화면 상태를 알 수 없어 실행하지 않음` };
      continue;
    }
    const result = await run(platform);
    if (desktop && result.tests.some((t) => t.code === 'display_unknown')) displayLost = platform;
    yield { platform, result, notRun: null };
  }
}
