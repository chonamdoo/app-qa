// Project paths and environment loading shared by every module.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PATHS = {
  root: ROOT,
  tools: join(ROOT, '.tools'),
  appiumHome: join(ROOT, '.tools', 'appium'),
  bin: join(ROOT, '.tools', 'bin'),
  state: join(ROOT, '.qa'),
  runs: join(ROOT, '.qa', 'runs'),
  locks: join(ROOT, '.qa', 'locks'),
  appBackups: join(ROOT, '.qa', 'apps'),
  inventory: join(ROOT, '.qa', 'inventory'),
  logs: join(ROOT, '.qa', 'logs'),
  apps: join(ROOT, 'apps'),
  tests: join(ROOT, 'tests'),
  calibration: join(ROOT, 'calibration'),
  fixtures: join(ROOT, 'fixtures'),
} as const;

let loaded = false;

/** Loads `.env` once (does not override variables already set in the process environment). */
export function loadEnv(file = join(ROOT, '.env')): void {
  if (loaded) return;
  loaded = true;
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined && value !== '') process.env[key] = expandHome(value);
  }
}

export function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

export function androidHome(): string {
  loadEnv();
  return expandHome(process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? '~/Library/Android/sdk');
}

export function adbPath(): string {
  return join(androidHome(), 'platform-tools', 'adb');
}

/** Replaces `${NAME}` with environment values; throws listing every unset name. */
export function expandVars(text: string, env: NodeJS.ProcessEnv = process.env): string {
  loadEnv();
  const missing: string[] = [];
  const out = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const v = env[name];
    if (v === undefined) {
      missing.push(name);
      return '';
    }
    return v;
  });
  if (missing.length) throw new Error(`Set ${[...new Set(missing)].join(', ')} in .env`);
  return out;
}
