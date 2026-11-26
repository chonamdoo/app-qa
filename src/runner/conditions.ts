import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { projectFixtureCanonical, projectFixtureSha256 } from '../core/project-fixture.ts';
import { AttemptBrowserEvidenceSchema, AttemptConditionsReceiptSchema, type AttemptBrowserEvidence, type AttemptConditionsReceipt, type AttemptMaterialConditions, type PublishedRevision, type RegressionAttempt } from '../core/regression.ts';
import { regressionGrantCanonical, regressionGrantSubjectSha256 } from '../policy/regression-grant.ts';
import { guestBrowserMaterial, type OriginalConditions } from './guest-conditions.ts';

const Text = z.string().min(1);
const Identity = z.object({
  browserSessionId: Text, browserVersion: Text, osVersion: Text, binary: Text, profile: Text, args: z.array(Text),
  os: z.object({ platform: Text, release: Text, arch: Text }),
  viewport: z.object({ width: z.number().positive(), height: z.number().positive() }),
  observed: z.object({ width: z.number().positive(), height: z.number().positive(), dpr: z.number().positive(), userAgent: Text, language: Text, timezone: Text }),
  // Attach mode can omit userDataDir; the observed browser arguments must still prove the owned profile.
  capabilities: z.object({ browserName: z.literal('chrome'), browserVersion: Text, chrome: z.object({ chromedriverVersion: Text, userDataDir: Text.optional() }), 'goog:chromeOptions': z.object({ debuggerAddress: Text }) }),
});

async function binaryEvidence(path: string): Promise<AttemptBrowserEvidence['browserBinary']> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size <= 0 || before.size > 256 * 1024 * 1024) throw new Error('binary_evidence_unavailable');
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (bytesRead === 0) throw new Error('binary_evidence_changed');
      digest.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await file.stat();
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('binary_evidence_changed');
    return { path, bytes: before.size, sha256: digest.digest('hex'), coverage: 'main-executable-only' };
  } finally { await file.close(); }
}

export async function observeAttemptBrowser(identity: Readonly<Record<string, unknown>> | null): Promise<AttemptBrowserEvidence | null> {
  const parsed = Identity.safeParse(identity);
  if (!parsed.success) return null;
  const actual = parsed.data;
  const version = /^(\d+\.\d+\.\d+\.\d+)(?:\s|$)/.exec(actual.capabilities.chrome.chromedriverVersion)?.[1];
  if (!version || actual.binary !== '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' || actual.os.platform !== 'darwin' || actual.os.arch !== 'arm64') return null;
  try {
    const [browserBinary, driverBinary] = await Promise.all([
      binaryEvidence(actual.binary), binaryEvidence(resolve('.tools', 'chromedriver', `chromedriver-mac-arm64_v${version}`)),
    ]);
    return AttemptBrowserEvidenceSchema.parse({ capturedAt: new Date().toISOString(), identity: structuredClone(identity), browserBinary, driverBinary });
  } catch { return null; }
}

// owned-chrome-ephemeral/v1 excludes only session/profile identifiers, owned transport port/process ID,
// instance allocation/generation and proof timestamps/lease receipt identifiers; all observed material is retained.
function materialBrowser(browser: AttemptBrowserEvidence): AttemptMaterialConditions['browser'] | null {
  const parsed = Identity.safeParse(browser.identity);
  if (!parsed.success) return null;
  const identity = parsed.data;
  if (identity.browserVersion !== identity.capabilities.browserVersion || identity.os.release !== identity.osVersion || (identity.capabilities.chrome.userDataDir !== undefined && identity.profile !== identity.capabilities.chrome.userDataDir) || identity.observed.width !== identity.viewport.width || identity.observed.height !== identity.viewport.height || browser.browserBinary.path !== identity.binary) return null;
  const driverVersion = /^(\d+\.\d+\.\d+\.\d+)(?:\s|$)/.exec(identity.capabilities.chrome.chromedriverVersion)?.[1];
  if (!driverVersion || !browser.driverBinary.path.endsWith(`/.tools/chromedriver/chromedriver-mac-arm64_v${driverVersion}`) || identity.binary !== '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' || identity.os.platform !== 'darwin' || identity.os.arch !== 'arm64' || identity.args.filter(argument => argument.startsWith('--user-data-dir=')).length !== 1 || !identity.args.includes(`--user-data-dir=${identity.profile}`)) return null;
  const material = structuredClone(browser.identity);
  delete material.browserSessionId;
  delete material.profile;
  material.args = identity.args.map(argument => argument === `--user-data-dir=${identity.profile}` ? '--user-data-dir=<owned-profile>' : argument);
  const capabilities = structuredClone(material.capabilities) as AttemptBrowserEvidence['identity'];
  const chrome = capabilities.chrome as AttemptBrowserEvidence['identity'];
  delete chrome.userDataDir;
  const options = capabilities['goog:chromeOptions'] as AttemptBrowserEvidence['identity'];
  const address = /^(localhost|127\.0\.0\.1):[1-9]\d*$/.exec(identity.capabilities['goog:chromeOptions'].debuggerAddress);
  if (!address) return null;
  options.debuggerAddress = `${address[1]}:<owned-port>`;
  delete capabilities['goog:processID'];
  material.capabilities = capabilities;
  return material;
}

function conditionsNormalization(original: OriginalConditions): AttemptConditionsReceipt['normalization'] {
  return original.worker?.runtime === 'macos-guest' || original.guest !== undefined ? 'macos-guest-ephemeral/v1' : 'owned-chrome-ephemeral/v1';
}
function derive(original: OriginalConditions): Pick<AttemptConditionsReceipt, 'material' | 'materialSha256' | 'status' | 'reason'> {
  const unverified = (reason: string) => ({ material: null, materialSha256: null, status: 'unverified' as const, reason });
  const { initial, final, browser, worker, subject } = original;
  if (!initial?.clientObservedAt) return unverified('initial_client_proof_missing');
  if (!final || final.phase !== 'cleanup' || final.cleanup !== 'complete' || final.effect !== 'committed' || final.comparison === 'unobserved') return unverified('final_cleanup_proof_missing');
  if (!worker || (worker.runtime === 'macos-guest' && !worker.machineId)) return unverified('actual_worker_identity_unavailable');
  let identity: AttemptMaterialConditions['browser'];
  let browserBinary: AttemptBrowserEvidence['browserBinary'], driverBinary: AttemptBrowserEvidence['driverBinary'];
  let capturedAt: number, materialWorkerId = worker.workerId;
  if (worker.runtime === 'macos-guest') {
    if (!original.guest?.browser) return unverified('actual_guest_browser_proof_missing');
    const actual = guestBrowserMaterial(original);
    if (!actual) return unverified('actual_guest_browser_scope_or_identity_inconsistent');
    identity = actual.browser; browserBinary = actual.browserBinary; driverBinary = actual.driverBinary;
    capturedAt = Date.parse(actual.capturedAt); materialWorkerId = actual.workerId;
  } else {
    if (original.guest !== undefined || original.target.platform !== 'desktop-chrome') return unverified('actual_browser_target_unsupported');
    if (!browser) return unverified('actual_browser_binary_or_identity_unavailable');
    const actual = materialBrowser(browser);
    if (!actual) return unverified('actual_browser_identity_inconsistent');
    identity = actual; browserBinary = browser.browserBinary; driverBinary = browser.driverBinary;
    capturedAt = Date.parse(browser.capturedAt);
  }
  if (initial.phase !== 'prepare' || initial.effect !== 'committed' || initial.comparison === 'unobserved' || Date.parse(initial.clientObservedAt) < Date.parse(initial.observedAt) || Date.parse(initial.clientObservedAt) > capturedAt || capturedAt >= Date.parse(initial.expiresAt) || capturedAt >= Date.parse(initial.lease.expiresAt)) return unverified('initial_client_proof_not_current');
  if (initial.cleanup !== 'not_started' || initial.ledger.pendingEffectIds.length !== 0 || initial.ledger.disposition !== 'active' || initial.ledger.fenceStatus !== 'active' || Date.parse(final.observedAt) < capturedAt || Date.parse(final.expiresAt) <= Date.parse(final.observedAt)) return unverified('fixture_proof_lifecycle_inconsistent');
  if ([initial, final].some(proof => proof.attemptId !== original.attemptId || proof.ownerId !== `attempt:${original.attemptId}` || proof.subjectSha256 !== regressionGrantSubjectSha256(subject) || proof.scopeSha256 !== createHash('sha256').update(regressionGrantCanonical(subject.scope)).digest('hex'))) return unverified('fixture_scope_identity_mismatch');
  if (final.lease.id !== initial.lease.id || final.lease.generation !== initial.lease.generation || final.lease.fence !== initial.lease.fence || final.ledger.pendingEffectIds.length !== 0 || final.ledger.fenceStatus !== 'revoked' || final.ledger.disposition !== 'drained' || final.ledger.restoration !== 'restored' || final.ledger.throughFence < final.lease.fence) return unverified('fixture_cleanup_ledger_incomplete');
  const material: AttemptMaterialConditions = {
    subject, subjectSha256: initial.subjectSha256, scopeSha256: initial.scopeSha256, adapterSha256: initial.adapterSha256,
    fixture: initial.state, browser: identity, browserBinary, driverBinary,
    worker: { runtime: worker.runtime, machineId: worker.machineId, workerId: materialWorkerId }, runtime: original.runtime,
    scheduling: 'local-user-serial-1',
  };
  const drift = initial.comparison === 'changed_conditions' || final.comparison === 'changed_conditions' || initial.adapterSha256 !== final.adapterSha256 || projectFixtureCanonical(initial.state) !== projectFixtureCanonical(final.state) || initial.state.currentStateSha256 !== subject.scope.fixture.initialStateSha256 || initial.state.baselineStateSha256 !== subject.scope.fixture.initialStateSha256;
  return { material, materialSha256: projectFixtureSha256(material), status: drift ? 'changed' : 'verified', reason: drift ? 'observed_fixture_conditions_drift' : null };
}

export function createAttemptConditions(original: OriginalConditions): AttemptConditionsReceipt {
  const { attemptId, revisionId, testId, target, runId, initial, final, browser, worker, runtime, subject } = original;
  const body = { schema: 'qautra/attempt-conditions/v1' as const, normalization: conditionsNormalization(original), attemptId, revisionId, testId, target, runId, initial, final, browser, worker, runtime, subject, ...(original.guest === undefined ? {} : { guest: original.guest }), ...derive(original) };
  return AttemptConditionsReceiptSchema.parse({ ...body, receiptSha256: projectFixtureSha256(body) });
}

export function validAttemptConditions(receipt: AttemptConditionsReceipt, attempt: RegressionAttempt, runtime?: PublishedRevision['definition']['runtime']): boolean {
  const parsed = AttemptConditionsReceiptSchema.safeParse(receipt);
  if (!parsed.success) return false;
  if (parsed.data.normalization !== conditionsNormalization(parsed.data)) return false;
  if (parsed.data.guest && parsed.data.guest.binding.context.grantId !== attempt.authorization.grantId) return false;
  const { receiptSha256, ...body } = parsed.data;
  if (receiptSha256 !== projectFixtureSha256(body) || receipt.attemptId !== attempt.attemptId || receipt.revisionId !== attempt.revisionId || receipt.testId !== attempt.testId || receipt.runId !== attempt.runId || projectFixtureCanonical(receipt.target) !== projectFixtureCanonical(attempt.target) || regressionGrantSubjectSha256(receipt.subject) !== attempt.authorization.subjectSha256 || receipt.subject.appId !== attempt.authorization.appId || projectFixtureCanonical(receipt.subject.target) !== projectFixtureCanonical(attempt.target)) return false;
  if (runtime && projectFixtureCanonical(runtime) !== projectFixtureCanonical(receipt.runtime)) return false;
  const derived = derive(receipt);
  return projectFixtureCanonical(derived) === projectFixtureCanonical({ material: receipt.material, materialSha256: receipt.materialSha256, status: receipt.status, reason: receipt.reason });
}

export function comparisonConditions(attempt: RegressionAttempt): { verified: boolean; changed: boolean; reason: string } {
  if (!attempt.conditions || !validAttemptConditions(attempt.conditions, attempt)) return { verified: false, changed: false, reason: 'actual_conditions_receipt_missing_or_inconsistent' };
  if (attempt.state !== 'finished' || attempt.evidence !== 'ready' || attempt.cleanup !== 'confirmed' || attempt.requiredChecks.length === 0 || new Set(attempt.completedChecks).size !== attempt.requiredChecks.length || attempt.requiredChecks.some(check => !attempt.completedChecks.includes(check))) return { verified: false, changed: false, reason: 'required_checks_evidence_or_cleanup_incomplete' };
  return { verified: attempt.conditions.status !== 'unverified', changed: attempt.conditions.status === 'changed', reason: attempt.conditions.reason ?? 'actual_conditions_verified' };
}
