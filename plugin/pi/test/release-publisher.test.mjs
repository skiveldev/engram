import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { runReleasePublisher } from '../release/release-publisher.mjs';
import { buildContractManifest } from '../release/contract-manifest.mjs';
import { buildArtifactIdentity } from '../release/artifact-evidence.mjs';
import { PROFILE_AGENT, PI_EXTRAS } from '../release/canonical-contract.mjs';

const root = resolve('../..');
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const state = join(common, 'gentle-checks/t4-publisher-test');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
const secrets = { PATH: process.env.PATH, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'owner/repository',
  GITHUB_SERVER_URL: 'https://github.com', GITHUB_SHA: source.commit, GITHUB_REF: 'refs/tags/v3.1.0',
  GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_WORKFLOW_REF: 'owner/repository/.github/workflows/release.yml@refs/tags/v3.1.0',
  GH_TOKEN: 'release-secret', HOMEBREW_TAP_TOKEN: 'tap-secret',
  NPM_PROMOTION_TOKEN: 'promotion-secret', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-secret', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.invalid' };
const names = version => ['linux', 'darwin', 'windows'].flatMap(os => ['amd64', 'arm64'].map(arch =>
  `engram_${version}_${os}_${arch}.${os === 'windows' ? 'zip' : 'tar.gz'}`));

async function fixture({ npm = false, core = false, draft = false, version = '3.1.0', failure, carrier = true, mismatch, tapSame = false, tapExisting = false } = {}) {
  await mkdir(state, { recursive: true });
  const dir = await mkdtemp(join(state, 'case-'));
  const preflightDirectory = join(dir, 'preflight'), coreDirectory = join(dir, 'core');
  await mkdir(join(preflightDirectory, 'npm'), { recursive: true }); await mkdir(coreDirectory);
  const tools = list => list.map(name => ({ name, inputSchema: { type: 'object' } }));
  const contract = buildContractManifest({ schema: 'engram.schema-capture/v2', source,
    mcp: tools(PROFILE_AGENT), pi: tools([...PROFILE_AGENT, ...PI_EXTRAS]) }, source);
  const tar = Buffer.from('exact npm candidate'), formula = Buffer.from('class Engram < Formula\nend\n');
  await writeFile(join(preflightDirectory, 'npm/candidate.tgz'), tar);
  await writeFile(join(preflightDirectory, 'contract-manifest.json'), contract.bytes);
  const receipts = [];
  for (const name of ['installer', 'go', 'pi', 'sdk-host', 'capture', 'pack']) {
    const stdout = name === 'pack' ? JSON.stringify([{ name: 'gentle-engram', version, filename: 'candidate.tgz' }]) : '';
    const bytes = Buffer.from(JSON.stringify({ stdout, stderr: '' }) + '\n');
    await writeFile(join(preflightDirectory, `${name}.log.json`), bytes);
    receipts.push({ name, exitCode: 0, status: 'passed', logDigest: hash(bytes) });
  }
  const evidence = { schema: 'engram.release-preflight/v1', status: 'passed', source, version, installerVersion: version,
    contractDigest: contract.contractDigest, npmDigest: hash(tar), npmFilename: 'candidate.tgz', receipts };
  await writeFile(join(preflightDirectory, 'preflight-evidence.json'), JSON.stringify(evidence));
  const coreAssets = [];
  for (const name of names(version)) {
    const bytes = Buffer.from(name); await writeFile(join(coreDirectory, name), bytes);
    coreAssets.push({ name, path: join(coreDirectory, name), bytes });
  }
  const sums = Buffer.from(coreAssets.map(asset => `${hash(asset.bytes)}  ${asset.name}`).join('\n') + '\n');
  await writeFile(join(coreDirectory, 'checksums.txt'), sums);
  coreAssets.push({ name: 'checksums.txt', path: join(coreDirectory, 'checksums.txt'), bytes: sums });
  const formulaPath = join(coreDirectory, 'engram.rb'); await writeFile(formulaPath, formula);
  const artifacts = { source, contractBytes: contract.bytes, contractDigest: contract.contractDigest, npmBytes: tar,
    coreAssets: [...coreAssets, { name: 'engram.rb', bytes: formula }] };
  const identity = buildArtifactIdentity(artifacts);
  const metadata = Buffer.from(JSON.stringify({ schema: 'engram.release-identity/v1', version,
    sourceCommit: identity.sourceCommit, sourceTree: identity.sourceTree, contractDigest: identity.contractDigest,
    npmDigest: identity.npmDigest, coreDigest: identity.coreDigest,
    contractBytes: contract.bytes.toString('base64'), coreManifestBytes: identity.coreManifestBytes.toString('base64') }) + '\n');
  const blobs = new Map(), calls = [], mutations = [];
  let release = core || draft ? { id: 9, tag_name: `v${version}`, target_commitish: source.commit, draft: !core, assets: [] } : null;
  const add = (name, bytes) => { const id = blobs.size + 1; blobs.set(String(id), bytes); release.assets.push({ id, name, size: bytes.length }); };
  if (release && carrier) add('engram-release-identity.json', mismatch === 'carrier' ? Buffer.from('{}\n') : metadata);
  if (core) for (const asset of artifacts.coreAssets) add(asset.name, mismatch === asset.name ? Buffer.from('changed') : asset.bytes);
  const config = { version, ref: `refs/tags/v${version}`, attemptId: `attempt-${dir.split('/').at(-1)}`, source,
    preflightDirectory, coreDirectory, coreAssets: coreAssets.map(({ name, path }) => ({ name, path })), formulaPath,
    repository: 'owner/repository', packageName: 'gentle-engram', trustedPublisher: true };
  const run = async (command, args, options) => {
    calls.push({ command, args: [...args], options });
    assert.equal(options.shell, false); assert.ok(options.timeout > 0); assert.ok(options.maxBuffer > 0);
    if (command === 'git') {
      if (args[0] === 'status') return { stdout: '' };
      if (args.includes('--git-common-dir')) return { stdout: common };
      return { stdout: args[1] === 'HEAD^{tree}' ? source.tree : source.commit };
    }
    if (command === 'npm' && args[0] === 'view') return { stdout: JSON.stringify(npm ? [version] : []) };
    if (command === 'gh' && args[1] === 'repos/owner/repository/releases') return { stdout: JSON.stringify([release ? [release] : []]) };
    if (command === 'npm' && args[0] === 'pack') {
      assert.equal(args[1], `gentle-engram@${version}`); assert.ok(args.includes('--ignore-scripts'));
      await writeFile(join(args.at(-1), 'remote.tgz'), mismatch === 'npm' ? Buffer.from('wrong') : tar);
      return { stdout: JSON.stringify([{ name: 'gentle-engram', filename: 'remote.tgz', version }]) };
    }
    if (command === 'gh' && args[1]?.includes('/releases/assets/')) {
      assert.deepEqual(args.slice(-2), ['-H', 'Accept: application/octet-stream']);
      return { stdout: blobs.get(args[1].split('/').at(-1)) };
    }
    if (command === 'gh' && args[1]?.includes('/releases/tags/')) return { stdout: JSON.stringify(release) };
    if (command === 'gh' && args[1] === 'repos/Gentleman-Programming/homebrew-tap') return { stdout: '{"full_name":"Gentleman-Programming/homebrew-tap"}' };
    if (command === 'gh' && args[1]?.endsWith('/contents/Formula') && !args.includes('PUT')) {
      return { stdout: JSON.stringify(tapExisting || tapSame ? [{ name: 'engram.rb', type: 'file' }] : []) };
    }
    if (command === 'gh' && args[1]?.endsWith('/contents/Formula/engram.rb') && !args.includes('PUT')) {
      const bytes = tapSame ? formula : Buffer.from('old formula');
      return { stdout: JSON.stringify({ type: 'file', encoding: 'base64', content: bytes.toString('base64'),
        sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') }) };
    }
    const action = command === 'npm' ? (args[0] === 'publish' ? 'npm' : args.at(-1) === `staging-${version}` ? 'staging-tag' : 'promotion') :
      args[0] === 'release' ? args[1] === 'create' ? 'reservation' : args[1] === 'upload' ? args[3].endsWith('engram-release-identity.json') ? 'carrier' : 'upload' : 'core' : 'tap';
    mutations.push(action);
    if (failure === action) throw new Error('injected release-secret promotion-secret tap-secret');
    if (action === 'reservation') release = { id: 9, tag_name: `v${version}`, target_commitish: source.commit, draft: true, assets: [] };
    if (action === 'carrier' || action === 'upload') add(args[3].split('/').at(-1), await readFile(args[3]));
    if (action === 'npm') assert.deepEqual(await readFile(args[1]), tar);
    if (action === 'core') release.draft = false;
    return { stdout: Buffer.from('injected output release-secret') };
  };
  const execute = (overrides = {}, env = secrets) => runReleasePublisher({ ...config, ...overrides }, { root, run, env });
  return { config, execute, runner: run, calls, mutations, dir, evidence, tar, formula, metadata, release, coreAssets };
}

function blocked(result, mutations) {
  assert.equal(result.status, 'blocked'); assert.deepEqual(result.completed, []); assert.deepEqual(mutations, []);
  assert.ok(!JSON.stringify(result).includes('secret'));
}
test('all four fresh states execute existing planner order, with draft reservation distinct from published core', async () => {
  for (const npm of [false, true]) for (const core of [false, true]) {
    const f = await fixture({ npm, core, draft: npm && !core }); const result = await f.execute();
    assert.equal(result.status, 'completed'); assert.equal(result.correctiveVersionRequired, false);
    assert.deepEqual(f.mutations, [...(!core && !npm ? ['reservation', 'carrier'] : []), npm ? 'staging-tag' : 'npm',
      ...(!core ? [...Array(8).fill('upload'), 'core'] : []), 'tap', 'promotion']);
    assert.deepEqual(result.completed, ['identity-reservation', 'npm-staging', 'core', 'homebrew', 'npm-promotion']);
    const publish = f.calls.find(c => c.command === 'npm' && c.args[0] === 'publish');
    if (publish) assert.deepEqual(publish.args.slice(2), ['--tag', 'staging-3.1.0', '--provenance', '--access', 'public']);
    for (const call of f.calls) {
      const env = call.options.env;
      if (call.command === 'gh') assert.equal(env.GH_TOKEN, call.args[1]?.includes('homebrew-tap') ? 'tap-secret' : 'release-secret');
      assert.equal(env.HOMEBREW_TAP_TOKEN, undefined);
      assert.equal(env.NPM_PROMOTION_TOKEN, undefined);
      assert.equal(env.NODE_AUTH_TOKEN, call.command === 'npm' && call.args[0] === 'dist-tag' ? 'promotion-secret' : undefined);
      if (call.command !== 'npm' || call.args[0] !== 'publish') {
        assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined); assert.equal(env.GITHUB_ACTIONS, undefined);
      } else {
        assert.equal(env.GITHUB_ACTIONS, 'true'); assert.equal(env.GITHUB_SHA, source.commit);
        assert.equal(env.GITHUB_WORKFLOW_REF, secrets.GITHUB_WORKFLOW_REF);
        assert.equal(await readFile(env.npm_config_userconfig, 'utf8'), 'registry=https://registry.npmjs.org/\n');
      }
      if (env.NODE_AUTH_TOKEN) assert.equal(await readFile(env.npm_config_userconfig, 'utf8'),
        'registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n');
    }
  }
});
test('npm-only recovery requires fresh draft carrier and exact remote tar bytes, never version identity', async () => {
  for (const opts of [{ npm: true }, { npm: true, draft: true, carrier: false }, { npm: true, draft: true, mismatch: 'npm' },
    { npm: true, draft: true, mismatch: 'carrier' }, { core: true, carrier: false }, { core: true, mismatch: 'engram.rb' }]) {
    const f = await fixture(opts); const result = await f.execute(); blocked(result, f.mutations);
    if (opts.mismatch) assert.equal(result.correctiveVersionRequired, true);
  }
});
test('prerelease skips Homebrew, stable requires tap auth, every attempt requires explicit publisher and promotion gates', async () => {
  const pre = await fixture({ version: '3.1.0-rc.1' }); const env = { ...secrets }; delete env.HOMEBREW_TAP_TOKEN;
  assert.equal((await pre.execute({}, env)).status, 'completed'); assert.ok(!pre.mutations.includes('tap'));
  assert.equal(pre.calls.filter(c => c.command === 'npm' && c.args[0] === 'dist-tag').at(-1).args.at(-1), 'next');
  for (const key of ['NPM_PROMOTION_TOKEN', 'HOMEBREW_TAP_TOKEN']) {
    const f = await fixture(); const missing = { ...secrets }; delete missing[key]; blocked(await f.execute({}, missing), f.mutations);
  }
  for (const trustedPublisher of [undefined, false, 'true']) {
    const f = await fixture(); blocked(await f.execute({ trustedPublisher }), f.mutations);
  }
});
test('strict inputs, path ownership, receipt source/version and byte checks reject without mutation', async () => {
  for (const change of [{ version: '3.01.0' }, { ref: 'v3.1.0' }, { attemptId: '../escape' }, { source: { ...source, tree: 'c'.repeat(40) } },
    { coreAssets: [] }, { coreDirectory: '/' }, { formulaPath: '/engram.rb' }]) {
    const f = await fixture(); blocked(await f.execute(change), f.mutations);
  }
  for (const kind of ['duplicate', 'basename', 'empty', 'symlink', 'receipt', 'version', 'npm', 'contract', 'checksum']) {
    const f = await fixture(); let change = {};
    if (kind === 'duplicate') change.coreAssets = [...f.config.coreAssets, f.config.coreAssets[0]];
    if (kind === 'basename') change.coreAssets = f.config.coreAssets.map((a, i) => i ? a : { ...a, name: '../bad' });
    if (kind === 'empty') await writeFile(f.config.formulaPath, '');
    if (kind === 'symlink') { const path = join(f.config.coreDirectory, 'linked.rb'); await symlink(f.config.formulaPath, path); change.formulaPath = path; }
    if (kind === 'receipt') await writeFile(join(f.config.preflightDirectory, 'pi.log.json'), 'changed');
    if (kind === 'version') await writeFile(join(f.config.preflightDirectory, 'preflight-evidence.json'), JSON.stringify({ ...f.evidence, version: '3.2.0' }));
    if (kind === 'npm') await writeFile(join(f.config.preflightDirectory, 'npm/candidate.tgz'), 'changed');
    if (kind === 'contract') await writeFile(join(f.config.preflightDirectory, 'contract-manifest.json'), '{}');
    if (kind === 'checksum') await writeFile(join(f.config.coreDirectory, 'checksums.txt'), 'invalid');
    blocked(await f.execute(change), f.mutations);
  }
});
test('unknown census and dirty/tag/source Git cannot become absence', async () => {
  for (const boundary of ['npm', 'gh', 'dirty', 'tag', 'head']) {
    const f = await fixture(); const result = await runReleasePublisher(f.config, { root, env: secrets, run: async (cmd, args, opts) => {
      if ((boundary === 'npm' && cmd === 'npm') || (boundary === 'gh' && cmd === 'gh')) throw new Error('secret');
      if (cmd === 'git' && boundary === 'dirty' && args[0] === 'status') return { stdout: ' M file' };
      if (cmd === 'git' && boundary === 'tag' && args[1] === `${f.config.ref}^{commit}`) return { stdout: 'c'.repeat(40) };
      if (cmd === 'git' && boundary === 'head' && args[1] === 'HEAD') return { stdout: 'c'.repeat(40) };
      // Reuse the fixture runner without exposing private implementation state.
      return f.runner(cmd, args, opts);
    } }); blocked(result, f.mutations);
  }
});
test('each mutation failure stops after its durable point, no retry/delete/rollback and no secret echo', async () => {
  for (const failure of ['reservation', 'carrier', 'npm', 'upload', 'core', 'tap', 'promotion']) {
    const f = await fixture({ failure }); const result = await f.execute();
    assert.equal(result.status, 'failed'); assert.equal(f.mutations.at(-1), failure);
    assert.equal(result.durablePoint, { reservation: null, carrier: 'draft-reservation', npm: 'identity-reservation',
      upload: 'npm-staging', core: 'core-upload:engram.rb', tap: 'core', promotion: 'homebrew' }[failure]);
    assert.equal(f.mutations.filter(x => x === failure).length, 1);
    assert.ok(!JSON.stringify(result).includes('secret'));
    if (failure !== 'promotion') assert.ok(!f.mutations.includes('promotion'));
  }
});
test('Homebrew existing bytes are a no-op; updates carry SHA and exact generated bytes', async () => {
  for (const tapSame of [true, false]) {
    const f = await fixture({ core: true, npm: true, tapExisting: true, tapSame });
    assert.equal((await f.execute()).status, 'completed');
    const put = f.calls.find(c => c.args.includes('PUT'));
    if (tapSame) assert.equal(put, undefined);
    else {
      assert.ok(put.args.some(arg => arg.startsWith('sha=')));
      assert.ok(put.args.includes(`content=${f.formula.toString('base64')}`));
      assert.ok(f.mutations.indexOf('tap') < f.mutations.indexOf('promotion'));
    }
  }
});
test('tap metadata, 404/auth and conditional-write failures never promote', async () => {
  for (const boundary of ['repository', 'directory', 'metadata', 'put']) {
    const f = await fixture({ core: true, npm: true, tapExisting: true });
    const result = await runReleasePublisher(f.config, { root, env: secrets, run: async (cmd, args, opts) => {
      if (cmd === 'gh' && args[1]?.includes('homebrew-tap')) {
        if (boundary === 'repository' && args[1].endsWith('homebrew-tap')) throw new Error('HTTP 404 secret');
        if (boundary === 'directory' && args[1].endsWith('/Formula')) return { stdout: '{}' };
        if (boundary === 'metadata' && args[1].endsWith('engram.rb')) return { stdout: '{"type":"file","encoding":"base64","content":"bad","sha":"bad"}' };
        if (boundary === 'put' && args.includes('PUT')) throw new Error('concurrent SHA change secret');
      }
      return f.runner(cmd, args, opts);
    } });
    assert.equal(result.status, 'failed'); assert.ok(!f.mutations.includes('promotion'));
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
});
test('carrier source/tree/contract/npm/core/schema/version differences block both destinations', async () => {
  for (const npm of [false, true]) for (const field of ['sourceCommit', 'sourceTree', 'contractDigest', 'npmDigest', 'coreDigest', 'schema', 'version', 'contractBytes', 'coreManifestBytes']) {
    const f = await fixture({ core: true, npm });
    const changed = JSON.parse(f.metadata); changed[field] = 'different';
    const data = Buffer.from(JSON.stringify(changed) + '\n');
    const carrier = f.release.assets.find(asset => asset.name === 'engram-release-identity.json'); carrier.size = data.length;
    const before = await readFile(join(f.config.preflightDirectory, 'npm/candidate.tgz'));
    const result = await runReleasePublisher(f.config, { root, env: secrets, run: async (cmd, args, opts) => {
      if (cmd === 'gh' && args[1] === `repos/owner/repository/releases/assets/${carrier.id}`) return { stdout: data };
      return f.runner(cmd, args, opts);
    } });
    blocked(result, f.mutations); assert.equal(result.correctiveVersionRequired, true);
    assert.deepEqual(await readFile(join(f.config.preflightDirectory, 'npm/candidate.tgz')), before);
  }
});
test('invalid remote npm metadata/path, release target and incomplete published files block without actions', async () => {
  for (const boundary of ['filename', 'version', 'pack-error', 'target', 'other-commit', 'incomplete', 'duplicate', 'draft-carrier']) {
    const f = await fixture({ npm: true, core: true });
    if (boundary === 'target') f.release.target_commitish = 'main';
    if (boundary === 'other-commit') f.release.target_commitish = 'c'.repeat(40);
    if (boundary === 'incomplete') f.release.assets.pop();
    if (boundary === 'duplicate') f.release.assets.push(f.release.assets[0]);
    if (boundary === 'draft-carrier') { f.release.draft = true; f.release.assets = []; }
    const result = await runReleasePublisher(f.config, { root, env: secrets, run: async (cmd, args, opts) => {
      if (cmd === 'npm' && args[0] === 'pack') {
        if (boundary === 'pack-error') throw new Error('registry authorization secret');
        if (boundary === 'filename') return { stdout: '[{"version":"3.1.0","filename":"../escape.tgz"}]' };
        if (boundary === 'version') return { stdout: '[{"version":"3.2.0","filename":"remote.tgz"}]' };
      }
      return f.runner(cmd, args, opts);
    } }); blocked(result, f.mutations);
    if (boundary === 'other-commit') assert.equal(result.correctiveVersionRequired, true);
  }
});
test('frozen candidate survives changed caller files; partial drafts reuse only freshly verified assets', async () => {
  const f = await fixture({ draft: true });
  const result = await runReleasePublisher(f.config, { root, env: secrets, run: async (cmd, args, opts) => {
    if (cmd === 'npm' && args[0] === 'publish') {
      await writeFile(join(f.config.preflightDirectory, 'npm/candidate.tgz'), 'caller changed');
      await writeFile(f.config.formulaPath, 'caller changed');
    }
    return f.runner(cmd, args, opts);
  } });
  assert.equal(result.status, 'completed');
  const put = f.calls.find(c => c.args.includes('PUT')); assert.ok(put.args.includes(`content=${f.formula.toString('base64')}`));
  assert.ok(!f.mutations.includes('reservation'));
  const partial = await fixture({ core: true, npm: true }); partial.release.draft = true;
  partial.release.assets.splice(2); // carrier plus one exact archive remain after an interrupted upload.
  assert.equal((await partial.execute()).status, 'completed'); assert.equal(partial.mutations.filter(x => x === 'upload').length, 7);
});
test('repeat attempts query anew, gates/input rejects preserve original files and zero commands where applicable', async () => {
  const f = await fixture({ core: true, npm: true });
  assert.equal((await f.execute()).status, 'completed');
  assert.equal((await f.execute({ attemptId: `${f.config.attemptId}-resume` })).status, 'completed');
  assert.equal(f.calls.filter(c => c.command === 'npm' && c.args[0] === 'view').length, 2);
  assert.equal(f.calls.filter(c => c.command === 'npm' && c.args[0] === 'pack').length, 2);
  for (const override of [{ trustedPublisher: false }, { repository: '-option/bad' }, { packageName: 'other-package' },
    { token: 'never allowed' }, { source: { commit: 'short', tree: source.tree } }]) {
    const invalid = await fixture(); const before = await readFile(join(invalid.config.preflightDirectory, 'preflight-evidence.json'));
    blocked(await invalid.execute(override), invalid.mutations);
    assert.deepEqual(await readFile(join(invalid.config.preflightDirectory, 'preflight-evidence.json')), before);
    if (override.trustedPublisher === false || override.token) assert.deepEqual(invalid.calls, []);
  }
});
test('CLI public help and invalid configuration have bounded exact outputs', () => {
  const script = resolve('release/release-publisher.mjs');
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.equal(help.stderr, '');
  assert.equal(help.stdout, 'Usage: node plugin/pi/release/release-publisher.mjs --config <absolute JSON configuration path>\n');
  const invalid = spawnSync(process.execPath, [script, '--unknown', 'secret'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, '');
  assert.equal(invalid.stderr, 'release publication blocked or failed\n');
});
