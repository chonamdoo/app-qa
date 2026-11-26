import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createExecutionAdmission } from '../../src/core/admission.ts';
import { sha256, writeJsonAtomic } from '../../src/core/fsx.ts';
import { ExecutionRecoveryViewSchema } from '../../src/core/recovery.ts';
import { regressionGrantSubjectSha256 } from '../../src/policy/regression-grant.ts';
import { baselineEntities, changedEntities, fixture } from '../fixtures/project-fixture.ts';

const script = fileURLToPath(new URL('../fixtures/native-recovery-controller.mjs', import.meta.url));
const available = process.env.QA_OWNED_CHROME_FIXTURE === '1' && process.platform === 'darwin' && process.arch === 'arm64';
interface Result { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
function child(mode: string, root: string): { process: ChildProcess; done: Promise<Result>; result(): Result | null } {
  const processChild = spawn(process.execPath, [script, mode, root], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', result: Result | null = null;
  const done = new Promise<Result>((resolve, reject) => {
    processChild.once('error', reject);
    processChild.stdout!.on('data', bytes => { stdout += bytes; if (stdout.length > 1024 * 1024) processChild.kill('SIGKILL'); });
    processChild.stderr!.on('data', bytes => { stderr = (stderr + bytes).slice(-65_536); });
    processChild.once('close', (code, signal) => { result = { code, signal, stdout, stderr }; resolve(result); });
  });
  return { process: processChild, done, result: () => result };
}
async function observation(mode: string, root: string) {
  const result = await child(mode, root).done;
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

it('recovers original native evidence and backend authority after controller death without replaying QA or changing its outcome', { skip: !available, timeout: 120_000 }, async t => {
  const retained = process.env.QAUTRA_RETAIN_NATIVE_RECOVERY === '1';
  const f = await fixture(t, { retain: true, leaseTtlMs: 20_000 });
  const instanceId = randomUUID(), profileId = randomUUID(), requestId = randomUUID();
  const directory = join(f.root, '.qa', 'admission');
  f.subject.target.deviceId = `chrome:${instanceId}`;
  for (const kind of ['type', 'clear'] as const) f.subject.scope.operations.push({ kind, effect: 'fixture-write', entityIds: ['order-1'], sinkIds: [] });
  for (const kind of ['launch', 'terminate', 'observe', 'capture-screen', 'record-video'] as const) f.subject.scope.operations.push({ kind, effect: 'read', entityIds: [], sinkIds: [] });
  f.subject.scope.effects.push('read');
  f.evidence.subject = structuredClone(f.subject); f.adapter.subjectSha256 = regressionGrantSubjectSha256(f.subject); f.save();
  for (const name of ['src', 'bin']) cpSync(join(process.cwd(), name), join(f.root, name), { recursive: true });
  for (const name of ['package.json', 'package-lock.json']) copyFileSync(join(process.cwd(), name), join(f.root, name));
  symlinkSync(join(process.cwd(), 'node_modules'), join(f.root, 'node_modules'));
  mkdirSync(join(f.root, '.tools', 'chromedriver'), { recursive: true, mode: 0o700 });
  copyFileSync(join(process.cwd(), '.tools', 'chromedriver', 'chromedriver-mac-arm64_v156.0.8078.80'), join(f.root, '.tools', 'chromedriver', 'chromedriver-mac-arm64_v156.0.8078.80'));
  writeJsonAtomic(join(f.root, 'apps', 'shop.yaml'), { id: 'shop', name: 'Original authority fixture', web: { url: f.origin, origins: [f.origin], platforms: ['desktop-chrome'], viewport: { width: 1280, height: 800 } } });
  writeJsonAtomic(join(f.root, 'tests', 'owned-recovery.e2e.yaml'), { id: 'owned-recovery', name: 'Owned controller loss', app: 'shop', platforms: ['desktop-chrome'], steps: [{ launch: true }, { type: '독립 QA 한글 123', into: { id: 'note' } }, { assertText: '독립 QA 한글 123' }, { tap: { id: 'commit' } }, { assertText: 'Committed' }, { wait: 10_000 }] });
  writeJsonAtomic(join(f.root, 'native-recovery.json'), { root: f.root, instanceId, profileId, requestId, target: f.subject.target, grantId: f.grant.grantId, subjectSha256: regressionGrantSubjectSha256(f.subject) });
  const controller = child('controller', f.root);
  let completed = false;
  try {
    const deadline = performance.now() + 40_000;
    while (f.state.appliedEffects !== 1 && performance.now() < deadline) {
      const early = controller.result();
      if (early) assert.fail(early.stderr || early.stdout || `controller exited ${early.code}`);
      await delay(100);
    }
    assert.equal(f.state.appliedEffects, 1);
    assert.deepEqual(f.state.entities, changedEntities);
    assert.ok(existsSync(join(f.root, 'native-recovery-accepted.json')));
    controller.process.kill('SIGKILL');
    const exit = await controller.done;
    assert.equal(exit.signal, 'SIGKILL');
    const before = { effects: f.state.appliedEffects, pageRequests: f.state.pageRequests, mutations: f.state.phases.filter(phase => phase !== 'observe') };
    const inspect = await observation('inspect', f.root);
    const blocked = ExecutionRecoveryViewSchema.parse(inspect.view);
    assert.equal(blocked.admission.state, 'unknown');
    assert.equal(inspect.native.native.browser.state, 'stopped');
    assert.equal(inspect.native.native.driver.state, 'stopped');
    assert.equal(inspect.native.native.profile, 'removed');
    assert.equal(inspect.native.recordings[0].status.media, 'valid');
    assert.equal(createExecutionAdmission(directory).status().state, 'unknown');
    const expiryDeadline = performance.now() + 60_000;
    while (Date.parse(f.lease()!.expiresAt) > Date.now()) {
      assert.ok(performance.now() < expiryDeadline, 'Original backend lease did not reach its observed wall-clock expiry');
      await delay(Math.max(1, Math.min(250, Date.parse(f.lease()!.expiresAt) - Date.now())));
    }
    f.restoreExpiredLease();
    assert.deepEqual(f.state.entities, baselineEntities);
    const oldCookie = await fetch(`${f.origin}/commit`, { method: 'POST', headers: { Cookie: `qa_fixture=${f.cookieValue}` } });
    assert.equal(oldCookie.status, 403);
    rmSync(join(f.root, '.qa', 'policy'), { recursive: true });
    const authorized = await child('authorize-and-crash', f.root).done;
    assert.equal(authorized.signal, 'SIGKILL', authorized.stderr);
    assert.equal(createExecutionAdmission(directory).status().state, 'idle');
    const recovered = await observation('recover', f.root);
    const readBack = await observation('reader', f.root);
    assert.deepEqual(recovered.runBefore, inspect.runAfter);
    assert.deepEqual(readBack.runAfter, inspect.runAfter);
    const view = ExecutionRecoveryViewSchema.parse(readBack.view);
    assert.equal(view.observation!.state, 'verified');
    assert.deepEqual({ effects: f.state.appliedEffects, pageRequests: f.state.pageRequests, mutations: f.state.phases.filter(phase => phase !== 'observe') }, before);
    const source = view.observation!.sources[0]!, segment = source.segments[0]!;
    assert.equal(source.context!.attemptId, inspect.accepted.attemptId);
    assert.equal(source.video, 'ready');
    const file = join(source.context!.runDir, segment.file);
    assert.equal(sha256(readFileSync(file)), segment.sha256);
    const media = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=dts_time:stream=codec_name,width,height,nb_frames:format=duration', '-of', 'json', file], { encoding: 'utf8' }));
    assert.deepEqual([media.streams[0].width, media.streams[0].height], [1280, 800]);
    assert.equal(media.packets.length, segment.frames);
    let previousDts = -Infinity;
    for (const packet of media.packets) {
      const dts = Number(packet.dts_time);
      assert.ok(Number.isFinite(dts) && dts > previousDts, 'Stored video decoding timestamps must advance');
      previousDts = dts;
    }
    // Preserve the VFR time base while decoding; the null sink's inferred rate can collapse distinct timestamps.
    execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-map', '0:v:0', '-fps_mode', 'passthrough', '-enc_time_base:v', 'demux', '-f', 'null', '-'], { timeout: 30_000 });
    const nextFixture = await fixture(t);
    nextFixture.subject.target = structuredClone(f.subject.target);
    nextFixture.subject.scope.operations = structuredClone(f.subject.scope.operations);
    nextFixture.subject.scope.effects = [...f.subject.scope.effects];
    nextFixture.evidence.subject = structuredClone(nextFixture.subject);
    nextFixture.adapter.subjectSha256 = regressionGrantSubjectSha256(nextFixture.subject);
    nextFixture.save();
    mkdirSync(join(f.root, '.qa', 'policy', 'regression', 'evidence'), { recursive: true, mode: 0o700 });
    cpSync(join(nextFixture.root, '.qa', 'policy'), join(f.root, '.qa', 'policy'), { recursive: true });
    writeJsonAtomic(join(f.root, 'apps', 'shop.yaml'), { id: 'shop', name: 'New independently authorized fixture', web: { url: nextFixture.origin, origins: [nextFixture.origin], platforms: ['desktop-chrome'], viewport: { width: 1280, height: 800 } } });
    writeJsonAtomic(join(f.root, 'native-recovery-next.json'), { requestId: randomUUID(), subjectSha256: regressionGrantSubjectSha256(nextFixture.subject) });
    const next = await observation('next', f.root);
    assert.deepEqual(next.runAfter, inspect.runAfter);
    assert.equal(nextFixture.state.appliedEffects, 1);
    assert.deepEqual(nextFixture.state.entities, baselineEntities);
    assert.equal(f.state.appliedEffects, before.effects);
    assert.equal(f.state.pageRequests, before.pageRequests);
    const summary = { root: f.root, inspect, recovered, readBack, next, media, backend: { ...before, phases: f.state.phases, fence: f.state.fence, restoration: f.state.restoration }, limits: ['Actual local Chrome/ChromeDriver and signed local backend fixture; no Safari/mobile or company backend attestation.', 'Backend negative-probe metadata is declared, not independently measured.', 'This test does not certify continuous host input noninterference.'] };
    writeJsonAtomic(join(f.root, 'native-recovery-summary.json'), summary);
    console.log(JSON.stringify({ result: 'actual-cold-recovery-complete', root: f.root, originalRunState: inspect.runAfter.state, recoveredAdmission: view.admission.state, native: inspect.native.native, segment, media, effects: f.state.appliedEffects }));
    completed = true;
  } finally {
    if (controller.process.exitCode === null && controller.process.signalCode === null) { controller.process.kill('SIGKILL'); await controller.done; }
    if (completed && !retained) rmSync(f.root, { recursive: true, force: true });
    else console.log(JSON.stringify({ retainedOriginalRecoveryEvidence: f.root }));
  }
});
