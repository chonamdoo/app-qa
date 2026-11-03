// Enforces the module table of skills/architecture/SKILL.md on every import under src/ and bin/.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../../src/core/config.ts';

type Module = 'contracts' | 'observe' | 'policy' | 'jev' | 'drivers' | 'runner' | 'plan' | 'server' | 'cli';

const MODULE_BY_DIR: Record<string, Module> = {
  'src/core': 'contracts',
  'src/spec': 'contracts',
  'src/observe': 'observe',
  'src/ocr': 'observe',
  'src/policy': 'policy',
  'src/jev': 'jev',
  'src/appium': 'drivers',
  'src/drivers': 'drivers',
  'src/runner': 'runner',
  'src/report': 'runner',
  'src/plan': 'plan',
  'src/server': 'server',
  'src/cli': 'cli',
  bin: 'cli',
};

function moduleOf(file: string): Module {
  for (const [dir, mod] of Object.entries(MODULE_BY_DIR)) if (file === dir || file.startsWith(`${dir}/`)) return mod;
  throw new Error(`${file} is not in any module of the architecture table`);
}

/** Whether `from` (a file of module `a`) may import `to` (a file of module `b`); same-module imports are always allowed. */
function allowed(from: string, to: string): boolean {
  const a = moduleOf(from);
  const b = moduleOf(to);
  if (a === b || a === 'cli' || b === 'contracts') return true;
  switch (a) {
    case 'policy':
      return to === 'src/observe/text.ts';
    case 'jev':
      return from === 'src/jev/calibrate.ts' && (b === 'observe' || b === 'policy');
    case 'drivers':
      return to === 'src/observe/android.ts' || to === 'src/observe/ios.ts' || to === 'src/observe/web.ts';
    case 'runner':
      return b === 'observe' || b === 'policy' || b === 'jev' || (b === 'drivers' && from === 'src/runner/index.ts');
    case 'plan':
      return b === 'observe' || b === 'policy' || b === 'jev' || to === 'src/runner/index.ts';
    default:
      return false;
  }
}

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(rel);
    return rel.endsWith('.ts') && !rel.endsWith('.d.ts') ? [rel] : [];
  });
}

/**
 * Specifiers of a module: `import … from` / `export … from`, side-effect `import 'x'`, and dynamic `import('x')` with a
 * literal specifier (quotes or a backtick string without `${`).
 */
const IMPORT = /(?:^|[\n;{}])\s*(?:import|export)\b[^'";]*?from\s*['"]([^'"]+)['"]|(?:^|[\n;{}])\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*(['"`])([^'"`$]+)\3\s*\)/g;

function specifiersOf(source: string): string[] {
  return [...source.matchAll(IMPORT)].map((m) => m[1] ?? m[2] ?? m[4]!);
}

/** Module edges (relative specifiers) of `from` (a root-relative path) whose text is `source`. */
function edgesOf(from: string, source: string): { from: string; to: string }[] {
  return specifiersOf(source)
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => ({ from, to: relative(ROOT, normalize(join(ROOT, dirname(from), specifier))) }));
}

/** Packages a contract file may import besides node builtins (`node:…`): the contract's dependency list. */
const CONTRACT_PACKAGES: Record<string, true> = { zod: true, yaml: true };

/** Package specifiers of a contract file outside `CONTRACT_PACKAGES` and `node:` builtins (relative ones are edges). */
function forbiddenPackages(source: string): string[] {
  return specifiersOf(source).filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:') && !Object.hasOwn(CONTRACT_PACKAGES, specifier));
}

const SOURCES = [...sourceFiles('src'), ...sourceFiles('bin')];

const EDGES = SOURCES.flatMap((from) => edgesOf(from, readFileSync(join(ROOT, from), 'utf8')));

test('contract files import only node builtins, zod, yaml and other contracts', () => {
  const violations = SOURCES.filter((file) => moduleOf(file) === 'contracts').flatMap((file) =>
    forbiddenPackages(readFileSync(join(ROOT, file), 'utf8')).map((specifier) => `${file} → ${specifier}`),
  );
  assert.deepEqual(violations, []);
});

test('every cross-module import is allowed by the architecture table', () => {
  const violations = EDGES
    .filter(({ from, to }) => !allowed(from, to))
    .map(({ from, to }) => `${from} (${moduleOf(from)}) → ${to} (${moduleOf(to)})`);
  assert.deepEqual(violations, []);
});

/**
 * What policy code (and every file it loads at runtime) may use: policy hashes and reads trusted grant files, but never
 * writes, spawns or touches the network. Everything is an allow-list over the source text: a new package, fs function,
 * alias, open flag or dynamic loading path fails until it is reviewed. It is a lexical guard, not a sandbox: it reads
 * names and literals as written and does not follow values, so a property name assembled at runtime is out of its reach.
 */
const POLICY_PACKAGES: Record<string, true> = { 'node:crypto': true, 'node:fs': true, 'node:path': true, zod: true };
const POLICY_FS_READS: Record<string, true> = {
  constants: true, closeSync: true, existsSync: true, fstatSync: true, lstatSync: true, openSync: true, readdirSync: true,
  readSync: true, realpathSync: true, statSync: true,
};
const POLICY_OPEN_FLAGS: Record<string, true> = { O_RDONLY: true, O_NOFOLLOW: true, O_NONBLOCK: true, O_CLOEXEC: true, O_DIRECTORY: true };
/** Ways to reach a module, global or process without a static import the allow-lists above can see (string text ignored). */
const POLICY_FORBIDDEN_CODE: [RegExp, string][] = [
  [/\bimport\s*\(/, 'dynamic import'],
  [/\b(?:require|eval|Function|global|globalThis|module|Reflect|fetch|WebSocket|XMLHttpRequest|EventSource|Bun|Deno)\b|\.\s*constructor\b/, 'global escape hatch'],
  [/\bprocess\b(?!\??\.getuid\b)/, 'process access'],
];
/** The same escape hatches written as string-keyed property names, checked before string text is emptied. */
const POLICY_FORBIDDEN_KEYS = /(['"`])(?:constructor|__proto__|prototype)\1/;

/** Specifiers loaded at runtime: `import type` / `export type` statements are erased by the compiler. */
function runtimeSpecifiers(source: string): string[] {
  return specifiersOf(source.replace(/(?:^|[\n;{}])\s*(?:import|export)\s+type\b[^'";]*?from\s*['"][^'"]+['"]/g, '\n'));
}

/**
 * Comments removed and regex literal bodies replaced by `/r/`, by a quote- and regex-aware scan, so `//` in a string
 * or a quote in a regex cannot hide the code after it.
 */
function withoutComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (quote) {
      out += c;
      if (c === '\\') out += source[++i] ?? '';
      else if (c === quote) quote = null;
    } else if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 1;
    } else if (c === '/' && (out.trim() === '' || /(?:[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof)\s*$/.test(out.slice(-16)))) {
      let inClass = false;
      for (i++; i < source.length && (inClass || source[i] !== '/'); i++) {
        if (source[i] === '\\') i++;
        else if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
      }
      while (/[a-z]/.test(source[i + 1] ?? '')) i++;
      out += '/r/';
    } else {
      if (c === "'" || c === '"' || c === '`') quote = c;
      out += c;
    }
  }
  return out;
}

/** Plain string text emptied; template interpolations kept, since they are code. */
function withoutStringText(code: string): string {
  return code
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`((?:\\.|[^`\\])*)`/g, (_, body: string) => ` ${[...body.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]).join(' ')} `);
}

/** Top-level arguments of the call whose `(` is at `open`; null when the parentheses never close. */
function callArguments(source: string, open: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < source.length; i++) {
    const c = source[i]!;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      depth--;
      if (depth === 0) return [...args, source.slice(start, i).trim()];
    } else if (c === ',' && depth === 1) {
      args.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  return null;
}

/** Every `openSync` use must be a direct call whose flags are only read-safe `constants.O_*` names. */
function openSyncProblems(code: string): string[] {
  const imports = [...code.matchAll(/(?:^|[\n;{}])\s*import\b[^'";]*?from\s*['"][^'"]+['"]/g)].map((m) => [m.index, m.index + m[0].length] as const);
  const problems: string[] = [];
  for (const match of code.matchAll(/\bopenSync\b/g)) {
    if (imports.some(([start, end]) => match.index >= start && match.index < end)) continue;
    const open = match.index + match[0].length;
    if (code[open] !== '(') { problems.push('openSync reference escape'); continue; }
    const args = callArguments(code, open);
    const flags = args?.[1]?.split('|').map((part) => part.trim().match(/^constants\.(O_[A-Z]+)$/)?.[1]);
    if (!args || args.length !== 2 || !flags?.every((flag) => flag !== undefined && Object.hasOwn(POLICY_OPEN_FLAGS, flag))) problems.push('unverified open flags');
  }
  return problems;
}

function policyEffects(source: string): string[] {
  const code = withoutComments(source);
  const packages = runtimeSpecifiers(code).filter((specifier) => !specifier.startsWith('.') && !Object.hasOwn(POLICY_PACKAGES, specifier));
  const reexports = [...code.matchAll(/(?:^|[\n;{}])\s*export\b(?!\s+type\b)[^'";]*?from\s*['"]([^'".][^'"]*)['"]/g)].map((m) => `re-export from ${m[1]}`);
  const fsClauses = [...code.matchAll(/(?:^|[\n;{}])\s*import\s+(?!type\b)([^'";]*?)\s*from\s*['"]node:fs['"]/g)].map((m) => m[1]!.trim());
  const fsShapes = fsClauses.filter((clause) => !/^\{[^}]*\}$/.test(clause)).map((clause) => `node:fs ${clause}`);
  const fsNames = fsClauses.filter((clause) => /^\{[^}]*\}$/.test(clause))
    .flatMap((clause) => clause.slice(1, -1).split(',').map((name) => name.trim()).filter(Boolean))
    .filter((name) => /\sas\s/.test(name) || !Object.hasOwn(POLICY_FS_READS, name)).map((name) => `node:fs ${name}`);
  const globals = POLICY_FORBIDDEN_CODE.filter(([pattern]) => pattern.test(withoutStringText(code))).map(([, label]) => label);
  const keys = POLICY_FORBIDDEN_KEYS.test(code) && !globals.includes('global escape hatch') ? ['global escape hatch'] : [];
  return [...packages, ...reexports, ...fsShapes, ...fsNames, ...globals, ...keys, ...openSyncProblems(code)];
}

/** Policy files plus every source file they load at runtime, transitively. */
function policyRuntimeClosure(): string[] {
  const seen = new Set<string>();
  const pending = SOURCES.filter((file) => moduleOf(file) === 'policy');
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(join(ROOT, file), 'utf8');
    for (const specifier of runtimeSpecifiers(source)) if (specifier.startsWith('.')) pending.push(relative(ROOT, normalize(join(ROOT, dirname(file), specifier))));
  }
  return [...seen].sort();
}

test('policy and everything it loads perform no network, process or file-write effects', () => {
  const closure = policyRuntimeClosure();
  assert.ok(closure.includes('src/policy/regression-grant.ts') && closure.includes('src/core/regression-grant.ts'));
  const violations = closure.flatMap((file) => policyEffects(readFileSync(join(ROOT, file), 'utf8')).map((effect) => `${file} → ${effect}`));
  assert.deepEqual(violations, []);
});

test('the policy effect check rejects every effect route a reviewer reproduced', () => {
  const cases: [string, string[]][] = [
    ["import { lookup } from 'node:dns/promises';", ['node:dns/promises']],
    ["import { request } from 'node:https';", ['node:https']],
    ["import { spawn } from 'child_process';", ['child_process']],
    ["import got from 'got';", ['got']],
    ["export { writeFileSync } from 'node:fs';", ['re-export from node:fs']],
    ["import * as fs from 'node:fs';\nfs.writeFileSync('x', '');", ['node:fs * as fs']],
    ["import fs from 'node:fs';\nfs.writeFileSync('x', '');", ['node:fs fs']],
    ["import { openSync, writeSync } from 'node:fs';", ['node:fs writeSync']],
    ["import { readFileSync } from 'node:fs';\nreadFileSync('x', { flag: 'w+' });", ['node:fs readFileSync']],
    ["import { openSync as openFile } from 'node:fs';\nopenFile('x', 'w');", ['node:fs openSync as openFile']],
    ["import { openSync } from 'node:fs';\nopenSync('x', 'w');", ['unverified open flags']],
    ["import { openSync } from 'node:fs';\nopenSync(join(root, f), 'w');", ['unverified open flags']],
    ["import { openSync } from 'node:fs';\nopenSync(p, 577);", ['unverified open flags']],
    ["import { openSync } from 'node:fs';\nconst flags = 'w';\nopenSync('x', flags);", ['unverified open flags']],
    ["import { openSync, constants } from 'node:fs';\nopenSync('x', constants.O_WRONLY | constants.O_CREAT);", ['unverified open flags']],
    ["import { openSync } from 'node:fs';\nconst open = openSync;\nopen('x', 'w');", ['openSync reference escape']],
    ["const fs = await import('node:fs');\nfs.writeFileSync('x', 'data');", ['dynamic import']],
    ['const m = await import(`node:${name}`);', ['dynamic import']],
    ["const m = await import('node:' + 'https');", ['dynamic import']],
    ["await fetch('https://example.test');", ['global escape hatch']],
    ["globalThis['fe' + 'tch']('https://example.test');", ['global escape hatch']],
    ["new Function('return 1')();", ['global escape hatch']],
    ["process.kill(1);", ['process access']],
    ['const s = `${globalThis.fetch(url)}`;', ['global escape hatch']],
    ["const s = 'a//b'; fetch(s);", ['global escape hatch']],
    ["const marker = 1; import { writeFileSync } from 'node:fs'; writeFileSync('x', 'data');", ['node:fs writeFileSync']],
    ["const marker = 1; export { writeFileSync } from 'node:fs';", ['re-export from node:fs']],
    ["const marker = 1; import { spawn } from 'node:child_process'; spawn('cmd');", ['node:child_process']],
    ["const r = /\"/; fetch(u); const t = \"\";", ['global escape hatch']],
    ["(() => {}).constructor('return 1')();", ['global escape hatch']],
    ["(() => {})['constructor']('return 1')();", ['global escape hatch']],
    ['const f = (() => {})["constructor"]; f("return fetch(url)")();', ['global escape hatch']],
    ["const p = ({})['__proto__'];", ['global escape hatch']],
    ["global['fe' + 'tch'](url);", ['global escape hatch']],
  ];
  for (const [source, expected] of cases) assert.deepEqual(policyEffects(source), expected, source);
  const reads = [
    "import { constants, fstatSync, openSync, readSync } from 'node:fs';",
    "import type { X } from 'node:http';",
    '// fetch() in a comment is not code',
    'const fd = openSync(join(root, f), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);',
    'process.getuid?.();',
    "const message = 'Mutations require explicit owned entities';",
  ].join('\n');
  assert.deepEqual(policyEffects(reads), []);
});

test('module dependency graph has no cycles', () => {
  const graph = new Map<Module, Set<Module>>();
  for (const { from, to } of EDGES) {
    const a = moduleOf(from);
    const b = moduleOf(to);
    if (a !== b) graph.set(a, (graph.get(a) ?? new Set()).add(b));
  }
  const cycles: string[] = [];
  const visit = (node: Module, path: Module[]): void => {
    if (path.includes(node)) {
      cycles.push([...path.slice(path.indexOf(node)), node].join(' → '));
      return;
    }
    for (const next of graph.get(node) ?? []) visit(next, [...path, node]);
  };
  for (const node of graph.keys()) visit(node, []);
  assert.deepEqual([...new Set(cycles)], []);
});

test('the allowance table rejects the edges the contract forbids', () => {
  assert.equal(allowed('src/jev/index.ts', 'src/cli/commands/calibrate.ts'), false);
  assert.equal(allowed('src/jev/decide.ts', 'src/observe/index.ts'), false);
  assert.equal(allowed('src/runner/engine.ts', 'src/drivers/index.ts'), false);
  assert.equal(allowed('src/server/server.ts', 'src/runner/index.ts'), false);
  assert.equal(allowed('src/drivers/android.ts', 'src/observe/index.ts'), false);
  assert.equal(allowed('src/jev/calibrate.ts', 'src/policy/risk.ts'), true);
  assert.equal(allowed('src/runner/index.ts', 'src/drivers/index.ts'), true);
});

test('side-effect and dynamic imports are collected, so a forbidden one is caught', () => {
  const source = [
    "import './steps.ts';",
    'import "../cli/commands/calibrate.ts";',
    'const m = await import(`../runner/index.ts`);',
    "export const n = () => import('../drivers/index.ts');",
    "import type { Snapshot } from '../core/types.ts';",
    "export * from './decide.ts';",
  ].join('\n');
  const edges = edgesOf('src/jev/x.ts', source);
  assert.deepEqual(
    edges.map((e) => e.to),
    ['src/jev/steps.ts', 'src/cli/commands/calibrate.ts', 'src/runner/index.ts', 'src/drivers/index.ts', 'src/core/types.ts', 'src/jev/decide.ts'],
  );
  assert.deepEqual(
    edges.filter(({ from, to }) => !allowed(from, to)).map((e) => e.to),
    ['src/cli/commands/calibrate.ts', 'src/runner/index.ts', 'src/drivers/index.ts'],
  );
});

test('a contract importing any other package is caught, in every import form', () => {
  const source = [
    "import { z } from 'zod';",
    "import type { Document } from 'yaml';",
    "import { readFileSync } from 'node:fs';",
    "import { STEP_KINDS } from './schema.ts';",
    "import jsonLogic from 'json-logic-js';",
    "import 'zod/v4';",
    'const m = await import(`fs`);',
    "export { parse } from 'yaml/util';",
  ].join('\n');
  assert.deepEqual(forbiddenPackages(source), ['json-logic-js', 'zod/v4', 'fs', 'yaml/util']);
});
