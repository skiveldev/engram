import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContractManifest } from '../release/contract-manifest.mjs';
import { PROFILE_AGENT, PI_EXTRAS } from '../release/canonical-contract.mjs';
import { buildArtifactIdentity } from '../release/artifact-evidence.mjs';
import { planPublicationAttempt } from '../release/publication-attempt.mjs';

const gateNames = ['goTests', 'piTests', 'packageChecks', 'profileParity', 'semanticContract', 'trustedPublisher'];
function fixture(version = '3.1.0') {
  const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const tools = names => names.map(name => ({ name, inputSchema: { type: 'object' } }));
  const manifest = buildContractManifest({ schema: 'engram.schema-capture/v2', source,
    mcp: tools(PROFILE_AGENT), pi: tools([...PROFILE_AGENT, ...PI_EXTRAS]) }, source);
  return { version, attemptId: 'current', artifacts: { source, contractBytes: manifest.bytes,
    contractDigest: manifest.contractDigest, npmBytes: new Uint8Array([1, 2]),
    coreAssets: [{ name: 'core.tar', bytes: new Uint8Array([3, 4]) }] },
    destinations: Object.fromEntries(['npm', 'core'].map(d => [d, { state: 'absent', attemptId: 'current', version }])),
    gates: Object.fromEntries(gateNames.map(g => [g, true])) };
}
function present(value, destination) {
  const identity = buildArtifactIdentity(value.artifacts);
  return { ...value.destinations[destination], state: 'present', sourceCommit: identity.sourceCommit,
    contractDigest: identity.contractDigest, contentDigest: identity[`${destination}Digest`] };
}
function check(value) {
  const before = structuredClone(value);
  const result = planPublicationAttempt(value);
  assert.deepEqual(structuredClone(value), before, 'pure planning leaves all supplied bytes and records unchanged');
  assert.deepEqual(planPublicationAttempt(value), result, 'results are stable');
  return result;
}
function blocked(value, reason, correctiveVersionRequired = false) {
  const result = check(value);
  assert.deepEqual(result.plan, { status: 'blocked', reason, correctiveVersionRequired, actions: [] });
  return result;
}
test('composition retains exact identity and all four resume states, staging before core then promotion', () => {
  for (const npm of [false, true]) for (const core of [false, true]) {
    const value = fixture();
    if (npm) value.destinations.npm = present(value, 'npm');
    if (core) value.destinations.core = present(value, 'core');
    assert.deepEqual(check(value), { candidate: { version: value.version, ...buildArtifactIdentity(value.artifacts) },
      plan: { status: 'ready', version: value.version, stagingTag: 'staging-3.1.0', promotionTag: 'latest',
        actions: [npm ? 'set-npm-staging-tag' : 'publish-npm-staging', ...(core ? [] : ['publish-core']), 'promote-npm'] } });
  }
});
test('strict versions and prerelease versus stable build tags remain planner behavior', () => {
  for (const [version, tag] of [['3.1.0-rc.1', 'next'], ['3.1.0+build-2', 'latest']]) {
    const result = check(fixture(version));
    assert.deepEqual(result.plan, { status: 'ready', version, stagingTag: `staging-${version}`,
      promotionTag: tag, actions: ['publish-npm-staging', 'publish-core', 'promote-npm'] });
  }
  for (const version of ['v3.1.0', '3.01.0', '3.1.0\n']) blocked(fixture(version), 'invalid-evidence');
});
test('missing, stale, unknown and malformed observations fail closed for both destinations', () => {
  for (const destination of ['npm', 'core']) {
    for (const change of [undefined, { state: 'unknown' }, { attemptId: 'old' }, { version: '3.1.1' },
      { state: 'missing' }, { state: 'present' }, { attemptId: undefined }]) {
      const value = fixture();
      value.destinations[destination] = change === undefined ? undefined : { ...value.destinations[destination], ...change };
      blocked(value, `invalid-destination-observation:${destination}`);
    }
  }
  const value = fixture(); value.attemptId = ' ';
  blocked(value, 'invalid-destination-observation:npm');
});
test('invalid artifact inputs block without identity or actions', () => {
  for (const value of [null, {}, ...[undefined, {}, { ...fixture().artifacts, npmBytes: 'not bytes' },
    { ...fixture().artifacts, contractDigest: '0'.repeat(64) }].map(artifacts => ({ ...fixture(), artifacts }))]) {
    assert.equal(blocked(value, 'invalid-artifact-evidence').candidate, null);
  }
});
test('all six explicit gates are required and never inferred', () => {
  for (const gate of gateNames) for (const evidence of [undefined, false, 'true', 1]) {
    const value = fixture(); value.gates[gate] = evidence;
    blocked(value, `unverified-gate:${gate}`);
  }
  const value = fixture(); delete value.gates;
  blocked(value, 'unverified-gate:goTests');
});
test('every immutable identity mismatch in either destination requires operator corrective version', () => {
  for (const destination of ['npm', 'core']) for (const field of ['sourceCommit', 'contractDigest', 'contentDigest']) {
    const value = fixture(); value.destinations[destination] = present(value, destination);
    value.destinations[destination][field] = 'd'.repeat(field === 'sourceCommit' ? 40 : 64);
    blocked(value, `immutable-mismatch:${destination}`, true);
  }
});
test('changed supplied artifact bytes reject matching old destination without writes', () => {
  for (const destination of ['npm', 'core']) {
    const value = fixture(); value.destinations[destination] = present(value, destination);
    if (destination === 'npm') value.artifacts.npmBytes[0]++;
    else value.artifacts.coreAssets[0].bytes[0]++;
    blocked(value, `immutable-mismatch:${destination}`, true);
  }
});
