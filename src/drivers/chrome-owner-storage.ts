import { randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { AgentExecutionError } from '../core/agent.ts';
import {
  ChromeOwnerAddressSchema, ChromeOwnerLocatorSchema, ChromeOwnerScopeSchema, ChromeOwnerSeedSchema,
  ChromeOwnerStateSchema, ChromeOwnerStoredStateSchema,
  type ChromeOwnerLocator, type ChromeOwnerScope, type ChromeOwnerSeed, type ChromeOwnerState,
} from '../core/chrome-owner.ts';
import { authenticChromeOwnerValue, chromeOwnerValueSignature } from '../core/chrome-owner-auth.ts';
import { ensureDir, readPrivateFile, sha256, writeAtomic, writeJsonAtomic } from '../core/fsx.ts';

export interface ChromeOwnerMaterial { readonly locator: ChromeOwnerLocator; readonly seed: ChromeOwnerSeed }
export function defaultChromeOwnersDirectory(): string { return join(homedir(), 'Library', 'Application Support', 'QAutra', 'execution', 'native-owners'); }
function privateDirectory(path: string, create = false): string {
  if (create) ensureDir(path);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new AgentExecutionError('chrome_owner_storage_unsafe', '소유 browser 기록은 private 실제 디렉터리여야 합니다', 'unknown');
  return realpathSync(path);
}
function decoded(bytes: Buffer): unknown { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
export function createChromeOwnerMaterial(input: {
  projectRoot: string; deviceId: string; registryRoot?: string;
  execution?: ChromeOwnerScope['execution']; instance?: ChromeOwnerScope['instance'];
}): ChromeOwnerMaterial {
  const projectRoot = resolve(input.projectRoot);
  const project = lstatSync(projectRoot);
  if (!project.isDirectory() || project.isSymbolicLink() || project.uid !== process.getuid?.()) throw new AgentExecutionError('chrome_project_unsafe', '원 프로젝트의 실제 소유 디렉터리가 필요합니다');
  ensureDir(projectRoot);
  const root = privateDirectory(resolve(input.registryRoot ?? defaultChromeOwnersDirectory()), true);
  const id = randomUUID();
  const directory = join(root, id);
  mkdirSync(directory, { mode: 0o700 });
  const scope = ChromeOwnerScopeSchema.parse({ id, projectRoot, deviceId: input.deviceId, execution: input.execution ?? null, instance: input.instance ?? null, createdAt: new Date().toISOString() });
  const seed = ChromeOwnerSeedSchema.parse({ schema: 'qautra/chrome-owner-seed/v1', scope, controlToken: randomBytes(32).toString('hex'), recoveryToken: randomBytes(32).toString('hex'), replyKey: randomBytes(32).toString('hex'), runtimeRoot: realpathSync(process.cwd()) });
  const bytes = `${JSON.stringify(seed, null, 2)}\n`;
  writeAtomic(join(directory, 'seed.json'), bytes);
  return { locator: { directory, ownerId: id, seedSha256: sha256(bytes) }, seed };
}
export function readChromeOwnerMaterial(input: ChromeOwnerLocator): ChromeOwnerMaterial {
  try {
    const locator = ChromeOwnerLocatorSchema.parse(input);
    const directory = privateDirectory(resolve(locator.directory));
    if (directory !== locator.directory || basename(directory) !== locator.ownerId) throw new Error('Owner directory identity mismatch');
    const bytes = readPrivateFile(join(directory, 'seed.json'), 65_536);
    if (sha256(bytes) !== locator.seedSha256) throw new Error('Original owner material changed');
    const seed = ChromeOwnerSeedSchema.parse(decoded(bytes));
    if (seed.scope.id !== locator.ownerId) throw new Error('Owner epoch mismatch');
    return { locator, seed };
  } catch { throw new AgentExecutionError('chrome_owner_material_unverified', '원 native 소유자 세대·private 자료를 확인할 수 없습니다. 새 소유자로 대체하지 않습니다', 'unknown'); }
}
export function assertChromeOwnerMaterial(material: ChromeOwnerMaterial): void {
  const current = readChromeOwnerMaterial(material.locator);
  if (JSON.stringify(current.seed) !== JSON.stringify(material.seed)) throw new AgentExecutionError('chrome_owner_material_unverified', '원 native 소유자 자료가 변경되었습니다', 'unknown');
}
export function writeChromeOwnerAddress(material: ChromeOwnerMaterial, port: number): void {
  assertChromeOwnerMaterial(material);
  const body = { schema: 'qautra/chrome-owner-address/v1' as const, scope: material.seed.scope, seedSha256: material.locator.seedSha256, port };
  const value = ChromeOwnerAddressSchema.parse({ ...body, signature: chromeOwnerValueSignature(material.seed.replyKey, 'address', body) });
  writeJsonAtomic(join(material.locator.directory, 'address.json'), value);
}
export function readChromeOwnerAddress(material: ChromeOwnerMaterial): number {
  assertChromeOwnerMaterial(material);
  const value = ChromeOwnerAddressSchema.parse(decoded(readPrivateFile(join(material.locator.directory, 'address.json'), 65_536)));
  const { signature, ...body } = value;
  if (body.seedSha256 !== material.locator.seedSha256 || JSON.stringify(body.scope) !== JSON.stringify(material.seed.scope) || !authenticChromeOwnerValue(material.seed.replyKey, 'address', body, signature)) throw new AgentExecutionError('chrome_owner_address_unverified', '기록된 native 제어 주소가 원 소유자와 다릅니다', 'unknown');
  return body.port;
}
export function writeChromeOwnerState(material: ChromeOwnerMaterial, input: ChromeOwnerState): void {
  assertChromeOwnerMaterial(material);
  const body = ChromeOwnerStateSchema.parse(input);
  if (body.seedSha256 !== material.locator.seedSha256 || JSON.stringify(body.scope) !== JSON.stringify(material.seed.scope)) throw new AgentExecutionError('chrome_owner_scope_changed', 'native 상태를 다른 세대에 기록하지 않습니다', 'unknown');
  writeJsonAtomic(join(material.locator.directory, 'state.json'), { body, signature: chromeOwnerValueSignature(material.seed.replyKey, 'state', body) });
}
export function readChromeOwnerState(material: ChromeOwnerMaterial): ChromeOwnerState {
  assertChromeOwnerMaterial(material);
  const value = ChromeOwnerStoredStateSchema.parse(decoded(readPrivateFile(join(material.locator.directory, 'state.json'), 2 * 1024 * 1024)));
  if (value.body.seedSha256 !== material.locator.seedSha256 || JSON.stringify(value.body.scope) !== JSON.stringify(material.seed.scope) || !authenticChromeOwnerValue(material.seed.replyKey, 'state', value.body, value.signature)) throw new AgentExecutionError('chrome_owner_state_unverified', '원 native 상태 기록을 검증하지 못했습니다', 'unknown');
  return value.body;
}
