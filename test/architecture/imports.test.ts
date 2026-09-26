// Enforces the module table of skills/architecture/SKILL.md on every relative import under src/ and bin/.
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
 * Relative specifiers of a module: `import … from` / `export … from`, side-effect `import './x.ts'`, and dynamic
 * `import('./x.ts')` with a literal specifier (quotes or a backtick string without `${`).
 */
const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*['"](\.[^'"]+)['"]|(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]|\bimport\(\s*(['"`])(\.[^'"`$]+)\3\s*\)/g;

/** Module edges of `from` (a root-relative path) whose text is `source`. */
function edgesOf(from: string, source: string): { from: string; to: string }[] {
  return [...source.matchAll(IMPORT)].map((m) => ({ from, to: relative(ROOT, normalize(join(ROOT, dirname(from), m[1] ?? m[2] ?? m[4]!))) }));
}

const EDGES = [...sourceFiles('src'), ...sourceFiles('bin')].flatMap((from) => edgesOf(from, readFileSync(join(ROOT, from), 'utf8')));

test('every cross-module import is allowed by the architecture table', () => {
  const violations = EDGES
    .filter(({ from, to }) => !allowed(from, to))
    .map(({ from, to }) => `${from} (${moduleOf(from)}) → ${to} (${moduleOf(to)})`);
  assert.deepEqual(violations, []);
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
