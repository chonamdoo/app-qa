import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';
import { sha256, writeJsonAtomic } from '../../src/core/fsx.ts';
import type { PublishedRevision, RevisionPayload } from '../../src/core/regression.ts';
import { createRevisionStore } from '../../src/runner/revisions.ts';
import { publishedRevisionEvidence } from '../../src/runner/revision-evidence.ts';
import { EvidenceSanitizer } from '../../src/runner/sanitize.ts';
import { tempRoot } from '../helpers/run.ts';

const firstSecret = 'literal-secret-4b2';
const secondSecret = 'another-secret-4b2';
async function publication() {
  const root = tempRoot({
    'apps/private.yaml': JSON.stringify({ id: 'private', name: 'profile-secret-91', redact: ['profile-secret-\\d+'], web: { url: 'https://example.test/?token=query-secret-55&safe=visible', platforms: ['desktop-chrome'] } }),
    'tests/private.e2e.yaml': JSON.stringify({ id: 'safe-test', name: `Input ${firstSecret}`, app: 'private', platforms: ['desktop-chrome'], reset: 'none', steps: [
      { type: firstSecret, into: { id: 'password' } },
      { type: secondSecret, into: { id: 'password' }, secure: true },
      { use: 'private.flow.yaml', with: { [firstSecret]: 'first-value', [secondSecret]: 'second-value' } },
      { assertText: 'safe expected result' },
    ] }),
    'tests/private.flow.yaml': JSON.stringify({ name: `flow ${firstSecret}`, steps: [{ assertText: firstSecret }] }),
  });
  const store = createRevisionStore({ root, appsDir: join(root, 'apps'), generatedDir: join(root, '.qa', 'generated') });
  const candidate = await store.preview(['tests/private.e2e.yaml']);
  assert.deepEqual(candidate.problems, []);
  const revision = await store.publish(candidate.candidateId, candidate.digest, candidate.definition.checks.map(check => check.id), { principalId: 'evidence-test-operator', channel: 'local-ui' });
  return { root, store, revision };
}

it('redacts secure and unmarked password inputs, duplicate flow text, profile patterns and query values without changing the executable original', async () => {
  const { root, store, revision } = await publication();
  const original = JSON.stringify(revision);
  const serialized = JSON.stringify(publishedRevisionEvidence(revision));
  for (const secret of [firstSecret, secondSecret, 'profile-secret-91', 'query-secret-55']) assert.equal(serialized.includes(secret), false, secret);
  const evidence = JSON.parse(serialized);
  assert.equal(evidence.schema, 'qautra/scenario-revision-evidence/v1');
  assert.equal(evidence.executable, false);
  assert.equal(Object.hasOwn(evidence, 'definition'), false);
  assert.equal(evidence.revisionId, revision.revisionId);
  assert.equal(evidence.review.digest, revision.review.digest);
  assert.equal(evidence.evidence.tests[0].id, 'safe-test');
  assert.equal(evidence.evidence.runtime.digest, revision.definition.runtime.digest);
  assert.ok(serialized.includes('safe=visible'));
  assert.ok(serialized.includes('first-value'));
  assert.ok(serialized.includes('second-value'));
  assert.equal(JSON.stringify(revision), original);
  assert.deepEqual(await store.get(revision.revisionId), revision);
  assert.ok(readFileSync(join(root, '.qa', 'product', 'revisions', `${revision.revisionId}.json`), 'utf8').includes(firstSecret));
});

it('registers snapshot literals into the same sanitizer later used for runtime evidence', async () => {
  const { revision } = await publication();
  const shared = new EvidenceSanitizer(revision.definition.tests[0]!.profile.redact);
  publishedRevisionEvidence(revision, shared);
  assert.equal(shared.text(`observed later: ${firstSecret}`).includes(firstSecret), false);
  assert.equal(shared.text(`observed later: ${secondSecret}`).includes(secondSecret), false);
});

it('protects environment-expanded values in a read-only legacy revision without executing or rewriting its source', async () => {
  const { root, store, revision } = await publication();
  assert.equal(revision.definition.schema, 'qautra/scenario-definition/v4');
  if (revision.definition.schema !== 'qautra/scenario-definition/v4') assert.fail('Expected current publication');
  const copied = structuredClone(revision.definition);
  const { chains: _chains, ...contents } = copied;
  const definition: RevisionPayload = { ...contents, schema: 'qautra/scenario-definition/v1' };
  const variable = 'QAUTRA_REVISION_EVIDENCE_SECRET';
  const previous = process.env[variable];
  process.env[variable] = 'env-secret-9a7';
  try {
    definition.tests[0]!.spec.steps[0] = { type: '${QAUTRA_REVISION_EVIDENCE_SECRET}', into: { id: 'password' }, secure: true };
    definition.tests[0]!.spec.name = 'legacy env-secret-9a7';
    const revisionId = sha256(JSON.stringify(definition));
    const historical: PublishedRevision = { schema: 'qautra/scenario-revision/v1', revisionId, publishedAt: revision.publishedAt, definition,
      review: { candidateId: revision.review.candidateId, digest: revisionId, checks: definition.checks.map(check => check.id) } };
    writeJsonAtomic(join(root, '.qa', 'product', 'revisions', `${revisionId}.json`), historical);
    const loaded = await store.get(revisionId);
    const original = JSON.stringify(loaded);
    assert.equal(JSON.stringify(publishedRevisionEvidence(loaded)).includes('env-secret-9a7'), false);
    assert.equal(JSON.stringify(loaded), original);
    assert.equal(loaded.definition.tests[0]!.spec.steps[0] && 'type' in loaded.definition.tests[0]!.spec.steps[0] ? loaded.definition.tests[0]!.spec.steps[0].type : null, '${QAUTRA_REVISION_EVIDENCE_SECRET}');
  } finally {
    if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous;
  }
});
