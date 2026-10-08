import assert from 'node:assert/strict';
import test from 'node:test';
import { createDestinationCliQueries } from '../release/destination-cli-queries.mjs';
import { PROFILE_AGENT, PI_EXTRAS } from '../release/canonical-contract.mjs';
import { buildContractManifest } from '../release/contract-manifest.mjs';
import { probeAndPlanPublicationAttempt } from '../release/destination-probes.mjs';

const config = { packageName: '@gentle/engram', repository: 'owner/repo' };
const request = destination => Object.freeze({ destination, version: '3.1.0', attemptId: 'current' });
const echo = (destination, state) => ({ ...request(destination), state });
function fixture() {
  const tools = names => names.map(name => ({ name, inputSchema: { type: 'object' } }));
  const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const contract = buildContractManifest({ schema: 'engram.schema-capture/v2', source,
    mcp: tools(PROFILE_AGENT), pi: tools([...PROFILE_AGENT, ...PI_EXTRAS]) }, source);
  return { attemptId: 'current', version: '3.1.0', artifacts: { source,
    contractBytes: contract.bytes, contractDigest: contract.contractDigest, npmBytes: new Uint8Array([1, 2]),
    coreAssets: [{ name: 'core.tar', bytes: new Uint8Array([3]) }] },
    gates: Object.fromEntries(['goTests', 'piTests', 'packageChecks', 'profileParity',
      'semanticContract', 'trustedPublisher'].map(name => [name, true])) };
}
function runner(responses, calls) {
  return async (exe, args, options) => {
    calls.push(exe);
    assert.deepEqual(args, exe === 'npm' ? ['view', config.packageName, 'versions', '--json'] :
      ['api', 'repos/owner/repo/releases', '--paginate', '--slurp']);
    assert.deepEqual(options, { shell: false, timeout: 30000, maxBuffer: 1048576 });
    const response = responses[exe];
    if (response instanceof Error) throw response;
    return { stdout: JSON.stringify(response), stderr: 'SECRET' };
  };
}
test('complete censuses, exact tags, fresh paired attempts and missing identity block', async () => {
  const calls = [], responses = { npm: ['3.0.0'], gh: [[{ tag_name: 'v3.0.0' }], []] };
  const queries = createDestinationCliQueries({ ...config, run: runner(responses, calls) });
  assert.deepEqual(calls, []);
  const input = fixture(), before = structuredClone(input);
  const ready = await probeAndPlanPublicationAttempt({ ...input, queries });
  assert.deepEqual(ready.plan, { status: 'ready', version: '3.1.0', stagingTag: 'staging-3.1.0',
    promotionTag: 'latest', actions: ['publish-npm-staging', 'publish-core', 'promote-npm'] });
  assert.deepEqual(calls, ['npm', 'gh']);
  for (const destination of ['npm', 'core']) {
    responses.npm = destination === 'npm' ? '3.1.0' : [];
    responses.gh = destination === 'core' ? [[], [{ tag_name: 'v3.1.0', ignored: true }]] : [];
    assert.deepEqual(await queries[destination](request(destination)), echo(destination, 'present'));
    const blocked = await probeAndPlanPublicationAttempt({ ...input, attemptId: `next-${destination}`, queries });
    assert.deepEqual(blocked.plan, { status: 'blocked', reason: `invalid-destination-observation:${destination}`,
      correctiveVersionRequired: false, actions: [] });
  }
  assert.equal(calls.length, 8);
  assert.deepEqual(structuredClone(input), before);
});
test('errors and malformed complete census never establish absence or leak diagnostics', async () => {
  for (const destination of ['npm', 'core']) {
    const invalid = destination === 'npm' ? [null, {}, [1], ['bad'], ['3.01.0']] :
      [null, {}, [{}], [[{}]], [[{ tag_name: 1 }]], [[{ tag_name: 'v3.1.0' }], null]];
    for (const value of [...invalid, new Error('E404 auth network SECRET'), 'badJSON']) {
      const calls = [];
      const responses = { npm: [], gh: [], [destination === 'npm' ? 'npm' : 'gh']: value };
      const fake = runner(responses, calls);
      const queries = createDestinationCliQueries({ ...config, run: value === 'badJSON' ?
        async (...args) => { await fake(...args); return { stdout: '{', stderr: 'SECRET' }; } : fake });
      assert.deepEqual(await queries[destination](request(destination)), echo(destination, 'unknown'));
      const result = await probeAndPlanPublicationAttempt({ ...fixture(), queries });
      assert.equal(result.plan.status, 'blocked');
      assert.deepEqual(result.plan.actions, []);
      assert.ok(!JSON.stringify(result).includes('SECRET'));
      assert.equal(calls.length, 3);
    }
  }
});
test('invalid configuration and requests execute nothing; unscoped name supported', async () => {
  let calls = 0;
  const run = async () => { calls++; return { stdout: '[]', stderr: '' }; };
  for (const packageName of ['--flag', '@a', 'a/b', 'a\n', '', 'A'])
    assert.throws(() => createDestinationCliQueries({ ...config, packageName, run }));
  for (const repository of ['https://host/a/b', '../repo', 'a/..', 'a/b/c', 'a/b\n', '-a/b'])
    assert.throws(() => createDestinationCliQueries({ ...config, repository, run }));
  assert.throws(() => createDestinationCliQueries({ ...config, run: null }));
  const queries = createDestinationCliQueries({ ...config, packageName: 'engram', run });
  for (const destination of ['npm', 'core']) for (const patch of [
    { version: '3.01.0' }, { version: '3.1.0\n' }, { attemptId: ' ' }, { destination: 'other' }]) {
    const input = Object.freeze({ ...request(destination), ...patch });
    const before = structuredClone(input);
    await assert.rejects(queries[destination](input));
    assert.deepEqual(input, before);
  }
  assert.equal(calls, 0);
  assert.deepEqual(await queries.npm(request('npm')), echo('npm', 'absent'));
  assert.equal(calls, 1);
});
