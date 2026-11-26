import { lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { AgentExecutionError } from '../core/agent.ts';
import { commitDirectory, readPrivateFile, sha256 } from '../core/fsx.ts';

export type ScriptSourceFile = 'script.mjs' | 'script.mts';

export function disposeScriptSource(directory: string, name: ScriptSourceFile, digest: string): void {
  const file = join(directory, name);
  let before: ReturnType<typeof lstatSync>;
  try { before = lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    commitDirectory(directory);
    return;
  }
  const bytes = readPrivateFile(file, 8_388_608);
  const after = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || sha256(bytes) !== digest) {
    throw new AgentExecutionError('source_disposal_failed', '실행 원본의 소유 inode·내용 digest가 달라 삭제하지 않았습니다');
  }
  unlinkSync(file);
  commitDirectory(directory);
}

export function legacyScriptSource(directory: string): ScriptSourceFile | null {
  const candidates: ScriptSourceFile[] = [];
  for (const name of ['script.mjs', 'script.mts'] as const) {
    try { lstatSync(join(directory, name)); candidates.push(name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (candidates.length > 1) throw new AgentExecutionError('source_disposal_failed', '이전 실행 원본의 언어·경로가 모호하여 어느 파일도 삭제하지 않았습니다');
  return candidates[0] ?? null;
}
