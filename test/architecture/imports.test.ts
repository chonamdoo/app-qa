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
      return to === 'src/observe/android.ts' || to === 'src/observe/ios.ts';
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

const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;

function edges(): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const from of [...sourceFiles('src'), ...sourceFiles('bin')]) {
    for (const m of readFileSync(join(ROOT, from), 'utf8').matchAll(IMPORT)) {
      const spec = m[1] ?? m[2]!;
      out.push({ from, to: relative(ROOT, normalize(join(ROOT, dirname(from), spec))) });
    }
  }
  return out;
}

test('every cross-module import is allowed by the architecture table', () => {
  const violations = edges()
    .filter(({ from, to }) => !allowed(from, to))
    .map(({ from, to }) => `${from} (${moduleOf(from)}) → ${to} (${moduleOf(to)})`);
  assert.deepEqual(violations, []);
});

test('module dependency graph has no cycles', () => {
  const graph = new Map<Module, Set<Module>>();
  for (const { from, to } of edges()) {
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
