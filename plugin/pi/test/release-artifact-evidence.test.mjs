import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalContract, PROFILE_AGENT, PI_EXTRAS } from '../release/canonical-contract.mjs';
import { buildArtifactIdentity, bindDestinationObservation } from '../release/artifact-evidence.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const tools = names => names.map(name => ({ name, inputSchema: { type: 'object' } }));
const contract = canonicalContract({ mcp: tools(PROFILE_AGENT), pi: tools([...PROFILE_AGENT, ...PI_EXTRAS]),
  variants: { schema: 'engram.accepted-variants/v1', dispositions: { fixture: 'explicit variant' } } });
const fixture = () => ({ source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
  contractBytes: contract.bytes, contractDigest: contract.digest, npmBytes: Buffer.from('tarball'),
  coreAssets: [{ name: 'z.zip', bytes: Buffer.from('z') }, { name: 'a.tar', bytes: new Uint8Array([1, 2]) }] });
const reject = (fn, message) => assert.throws(fn, { name: 'TypeError', message });

test('artifact hashes bind exact bytes, sorted names, contract and source without mutation', () => {
  const input = fixture();
  const before = structuredClone(input);
  const result = buildArtifactIdentity(input);
  const assets = [{ name: 'a.tar', digest: sha(input.coreAssets[1].bytes) },
    { name: 'z.zip', digest: sha(input.coreAssets[0].bytes) }];
  const coreManifestBytes = Buffer.from(`${JSON.stringify({ schema: 'engram.core-assets/v1', assets })}\n`);
  assert.deepEqual(result, { sourceCommit: input.source.commit, sourceTree: input.source.tree,
    contractDigest: contract.digest, npmDigest: sha(input.npmBytes), coreDigest: sha(coreManifestBytes),
    coreAssets: assets, coreManifestBytes });
  assert.deepEqual(structuredClone(input), before);
  assert.deepEqual(buildArtifactIdentity({ ...input, coreAssets: [...input.coreAssets].reverse() }), result);
  for (const [field, changed] of [
    ['npmDigest', { npmBytes: Buffer.from('tarball!') }],
    ['coreDigest', { coreAssets: [{ name: 'other', bytes: Buffer.from('z') }] }],
    ['coreDigest', { coreAssets: input.coreAssets.map(a => ({ ...a, bytes: Buffer.from('changed') })) }],
  ]) {
    const next = buildArtifactIdentity({ ...input, ...changed });
    assert.notEqual(next[field], result[field]);
    for (const untouched of ['npmDigest', 'coreDigest', 'contractDigest'].filter(k => k !== field))
      assert.equal(next[untouched], result[untouched]);
  }
});

test('artifact evidence rejects missing binding, noncanonical contract, invalid bytes and assets', () => {
  const input = fixture();
  const cases = [
    { source: undefined }, { source: { commit: input.source.commit } },
    { source: { commit: 'bad', tree: input.source.tree } },
    { contractDigest: '0'.repeat(64) }, { contractDigest: 'BAD' },
    { contractBytes: Buffer.from('{}\n') },
    { contractBytes: Buffer.from(contract.bytes.toString().trim()), contractDigest: sha(Buffer.from(contract.bytes.toString().trim())) },
    { npmBytes: 'tarball' }, { coreAssets: [] }, { coreAssets: null },
    { coreAssets: [{ name: '', bytes: Buffer.from('x') }] },
    { coreAssets: [{ name: 'a', bytes: 'x' }] },
    { coreAssets: [{ name: 'a', bytes: Buffer.from('x'), digest: 'bad' }] },
    { coreAssets: [{ name: 'a', bytes: Buffer.from('x'), digest: '0'.repeat(64) }] },
    { coreAssets: [input.coreAssets[0], input.coreAssets[0]] },
  ];
  for (const change of cases) {
    const candidate = { ...input, ...change };
    const before = structuredClone(candidate);
    reject(() => buildArtifactIdentity(candidate), 'invalid artifact evidence');
    assert.deepEqual(structuredClone(candidate), before);
  }
  const matching = input.coreAssets.map(a => ({ ...a, digest: sha(a.bytes) }));
  assert.deepEqual(buildArtifactIdentity({ ...input, coreAssets: matching }), buildArtifactIdentity(input));
});

const candidate = () => ({ version: '1.2.3', ...buildArtifactIdentity(fixture()) });
const observation = c => ({ attemptId: 'attempt-1', version: c.version, state: 'present',
  sourceCommit: c.sourceCommit, contractDigest: c.contractDigest, contentDigest: c.npmDigest });

test('destination observation binds current attempt and version, preserving absent/present planner fields', () => {
  const c = candidate();
  for (const destination of ['npm', 'core']) {
    for (const state of ['present', 'absent']) {
      const observed = { ...observation(c), state, contentDigest: c[`${destination}Digest`] };
      const before = structuredClone(observed);
      assert.deepEqual(bindDestinationObservation({ attemptId: 'attempt-1', destination, candidate: c, observation: observed }), observed);
      assert.deepEqual(observed, before);
    }
  }
});

test('destination observation rejects unknown, malformed, missing and previous-attempt evidence', () => {
  const c = candidate();
  const base = { attemptId: 'attempt-1', destination: 'npm', candidate: c, observation: observation(c) };
  for (const change of [{ attemptId: '' }, { attemptId: ' ' }, { destination: 'other' }, { candidate: null },
    { observation: undefined }, ...[
      { state: 'unknown' }, { state: undefined }, { attemptId: 'old' }, { attemptId: undefined },
      { version: '1.2.4' }, { version: undefined }, { sourceCommit: undefined },
      { sourceCommit: 'bad' }, { contractDigest: 'bad' }, { contentDigest: 'bad' },
      { state: 'absent', version: '1.2.4' },
    ].map(fields => ({ observation: { ...base.observation, ...fields } }))]) {
    const input = { ...base, ...change };
    const before = structuredClone(input);
    reject(() => bindDestinationObservation(input), 'invalid destination observation');
    assert.deepEqual(structuredClone(input), before);
  }
  // Valid immutable differences remain visible for the planner to block, not rewritten.
  const mismatch = { ...base.observation, contentDigest: '0'.repeat(64) };
  assert.deepEqual(bindDestinationObservation({ ...base, observation: mismatch }), mismatch);
});
