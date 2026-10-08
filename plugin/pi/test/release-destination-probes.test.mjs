import assert from 'node:assert/strict';
import test from 'node:test';
import { PROFILE_AGENT, PI_EXTRAS } from '../release/canonical-contract.mjs';
import { buildContractManifest } from '../release/contract-manifest.mjs';
import { buildArtifactIdentity } from '../release/artifact-evidence.mjs';
import { probeAndPlanPublicationAttempt } from '../release/destination-probes.mjs';

const destinations = ['npm', 'core'];
const gateNames = ['goTests', 'piTests', 'packageChecks', 'profileParity', 'semanticContract', 'trustedPublisher'];
function fixture(version = '3.1.0') {
  const tools = names => names.map(name => ({ name, inputSchema: { type: 'object' } }));
  const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const contract = buildContractManifest({ schema: 'engram.schema-capture/v2', source,
    mcp: tools(PROFILE_AGENT), pi: tools([...PROFILE_AGENT, ...PI_EXTRAS]) }, source);
  return { attemptId: 'current', version, artifacts: { source,
    contractBytes: contract.bytes, contractDigest: contract.contractDigest, npmBytes: new Uint8Array([1, 2]),
    coreAssets: [{ name: 'core.tar', bytes: new Uint8Array([3]) }] },
    gates: Object.fromEntries(gateNames.map(name => [name, true])) };
}
function present(input, destination) {
  const identity = buildArtifactIdentity(input.artifacts);
  return { state: 'present', sourceCommit: identity.sourceCommit, contractDigest: identity.contractDigest,
    contentDigest: identity[`${destination}Digest`] };
}
async function run(input, observations, expectedReason, correctiveVersionRequired = false) {
  const before = structuredClone(input);
  const records = structuredClone(observations);
  const calls = [];
  const queries = Object.fromEntries(destinations.map(destination => [destination, async request => {
    assert.ok(Object.isFrozen(request));
    assert.deepEqual(request, { attemptId: input.attemptId, version: input.version, destination });
    calls.push(destination);
    if (observations[destination] instanceof Error) throw observations[destination];
    return observations[destination];
  }]));
  const result = await probeAndPlanPublicationAttempt({ ...input, queries });
  assert.deepEqual(calls.sort(), destinations.slice().sort());
  assert.deepEqual(structuredClone(input), before);
  assert.deepEqual(structuredClone(observations), records);
  if (expectedReason) assert.deepEqual(result.plan, { status: 'blocked', reason: expectedReason,
    correctiveVersionRequired, actions: [] });
  return result;
}
test('fresh immutable requests on every attempt, same-version four-state recovery', async () => {
  const input = fixture();
  const calls = [];
  let observations;
  const queries = Object.fromEntries(destinations.map(destination => [destination, request => {
    calls.push(request);
    assert.ok(Object.isFrozen(request));
    return observations[destination];
  }]));
  for (const npm of [false, true]) for (const core of [false, true]) {
    input.attemptId = `attempt-${calls.length}`;
    observations = { npm: npm ? present(input, 'npm') : { state: 'absent' },
      core: core ? present(input, 'core') : { state: 'absent' } };
    const before = structuredClone({ input, observations });
    const result = await probeAndPlanPublicationAttempt({ ...input, queries });
    assert.deepEqual(calls.slice(-2), destinations.map(destination => ({ attemptId: input.attemptId,
      version: input.version, destination })));
    assert.deepEqual(result.plan, { status: 'ready', version: input.version, stagingTag: 'staging-3.1.0',
      promotionTag: 'latest', actions: [npm ? 'set-npm-staging-tag' : 'publish-npm-staging',
        ...(core ? [] : ['publish-core']), 'promote-npm'] });
    assert.deepEqual(structuredClone({ input, observations }), before);
  }
  assert.equal(calls.length, 8);
  assert.equal(new Set(calls).size, 8);
});
test('each immutable field mismatch blocks either destination without version correction', async () => {
  for (const destination of destinations) for (const field of ['sourceCommit', 'contractDigest', 'contentDigest']) {
    const input = fixture();
    const observations = { npm: { state: 'absent' }, core: { state: 'absent' } };
    observations[destination] = { ...present(input, destination), [field]: 'd'.repeat(field === 'sourceCommit' ? 40 : 64) };
    await run(input, observations, `immutable-mismatch:${destination}`, true);
  }
});
test('unknown, thrown, malformed, stale echoes and missing identities fail closed with both queries', async () => {
  for (const destination of destinations) {
    const input = fixture();
    for (const observation of [undefined, null, [], 'absent', { state: 'unknown' }, { state: 'missing' },
      new Error('secret remote diagnostic'), { state: 'absent', attemptId: 'old' },
      { state: 'absent', version: '3.1.1' }, { state: 'absent', destination: destination === 'npm' ? 'core' : 'npm' },
      ...['sourceCommit', 'contractDigest', 'contentDigest'].map(field => ({ ...present(input, destination), [field]: undefined })),
      { ...present(input, destination), contentDigest: 'unverified' }]) {
      await run(input, { npm: { state: 'absent' }, core: { state: 'absent' }, [destination]: observation },
        `invalid-destination-observation:${destination}`);
    }
  }
  await run(fixture('3.1.0-rc.1'), { npm: { state: 'absent', attemptId: 'current', version: '3.1.0-rc.1' },
    core: { state: 'absent' } });
});
test('invalid candidate/artifacts/attempt and every missing gate reject before queries', async () => {
  const invalid = [null, {}, { ...fixture(), artifacts: {} }, { ...fixture(), attemptId: ' ' },
    ...['v3.1.0', '3.01.0', '3.1.0\n'].map(version => fixture(version))];
  for (const gate of gateNames) for (const value of [undefined, false, 'true', 1]) {
    const input = fixture(); input.gates[gate] = value; invalid.push(input);
  }
  for (const input of invalid) {
    const before = structuredClone(input);
    let calls = 0;
    const query = () => { calls++; return { state: 'absent' }; };
    const result = await probeAndPlanPublicationAttempt({ ...input, queries: { npm: query, core: query } });
    assert.equal(result.plan.status, 'blocked');
    assert.deepEqual(result.plan.actions, []);
    assert.equal(calls, 0);
    assert.deepEqual(structuredClone(input), before);
  }
});
test('prerelease and build versions retain existing promotion behavior; missing adapters block', async () => {
  for (const [version, tag] of [['3.1.0-rc.1', 'next'], ['3.1.0+build-2', 'latest']]) {
    const result = await run(fixture(version), { npm: { state: 'absent' }, core: { state: 'absent' } });
    assert.equal(result.plan.version, version);
    assert.equal(result.plan.promotionTag, tag);
  }
  const result = await probeAndPlanPublicationAttempt(fixture());
  assert.deepEqual(result.plan, { status: 'blocked', reason: 'invalid-destination-observation:npm',
    correctiveVersionRequired: false, actions: [] });
});
