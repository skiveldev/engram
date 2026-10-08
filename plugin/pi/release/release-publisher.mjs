import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifactIdentity } from './artifact-evidence.mjs';
import { planPublicationAttempt } from './publication-attempt.mjs';
import { createDestinationCliQueries } from './destination-cli-queries.mjs';
import { assertReleaseVersionAgreement } from './version-contract.mjs';

const executeFile = promisify(execFile);
const help = 'Usage: node plugin/pi/release/release-publisher.mjs --config <absolute JSON configuration path>\n';
const carrierName = 'engram-release-identity.json';
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const digest = /^[a-f0-9]{64}$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value) + '\n');
const within = (base, path) => {
  const part = relative(base, path);
  return part !== '' && part !== '..' && !part.startsWith('../') && !isAbsolute(part);
};
function reject(reason, correctiveVersionRequired = false) {
  const error = new Error(reason);
  error.reason = reason; error.correctiveVersionRequired = correctiveVersionRequired;
  throw error;
}
function bytes(value) {
  if (typeof value === 'string') return Buffer.from(value);
  if (Buffer.isBuffer(value)) return value;
  reject('invalid-command-output');
}
function decode(value) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes(value)));
}
function archiveNames(version) {
  return ['linux', 'darwin', 'windows'].flatMap(os => ['amd64', 'arm64'].map(arch =>
    `engram_${version}_${os}_${arch}.${os === 'windows' ? 'zip' : 'tar.gz'}`));
}

/** Execute only frozen caller-provided artifacts. Injection supplies offline IO, not publication authority. */
export async function runReleasePublisher(config, { root, run = executeFile, env = process.env } = {}) {
  const completed = [];
  let mutating = false, durablePoint = null;
  try {
    const allowed = ['version', 'ref', 'attemptId', 'source', 'preflightDirectory', 'coreDirectory',
      'coreAssets', 'formulaPath', 'repository', 'packageName', 'trustedPublisher'];
    if (!config || Array.isArray(config) || Object.keys(config).some(key => !allowed.includes(key)) ||
        typeof root !== 'string' || typeof run !== 'function' ||
        typeof config.attemptId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(config.attemptId) ||
        !objectId.test(config.source?.commit ?? '') || !objectId.test(config.source?.tree ?? '')) reject('invalid-configuration');
    const version = assertReleaseVersionAgreement({ route: 'core', releaseRef: config.ref,
      packageVersion: config.version, installerVersion: config.version });
    const stable = !version.split('+')[0].includes('-');
    if (config.trustedPublisher !== true) reject('unverified-trusted-publisher');
    const credential = key => typeof env[key] === 'string' && env[key].trim() && !/[\r\n\0]/.test(env[key]);
    if (!credential('NPM_PROMOTION_TOKEN')) reject('missing-promotion-credential');
    if (!credential('GH_TOKEN') || !credential('ACTIONS_ID_TOKEN_REQUEST_TOKEN') || !credential('ACTIONS_ID_TOKEN_REQUEST_URL')) reject('missing-release-credential');
    if (stable && !credential('HOMEBREW_TAP_TOKEN')) reject('missing-homebrew-credential');
    root = resolve(root);
    if (await realpath(root) !== root) reject('invalid-root-ownership');
    const baseEnv = { PATH: env.PATH ?? process.env.PATH, NO_UPDATE_NOTIFIER: '1',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    let home, npmConfig;
    const command = async (program, args, destination = 'read') => {
      const isolated = { ...baseEnv };
      if (home) Object.assign(isolated, { HOME: home, TMPDIR: home, GH_CONFIG_DIR: join(home, 'gh'),
        npm_config_cache: join(home, 'npm-cache') });
      if (program === 'gh') isolated.GH_TOKEN = destination === 'tap' ? env.HOMEBREW_TAP_TOKEN : env.GH_TOKEN;
      if (program === 'npm' && npmConfig) {
        isolated.npm_config_userconfig = npmConfig;
        isolated.npm_config_globalconfig = join(home, 'global.npmrc');
      }
      if (destination === 'staging') {
        isolated.ACTIONS_ID_TOKEN_REQUEST_TOKEN = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
        isolated.ACTIONS_ID_TOKEN_REQUEST_URL = env.ACTIONS_ID_TOKEN_REQUEST_URL;
        // npm's provenance provider detection and statement generation require CI metadata.
        for (const key of ['GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_SERVER_URL', 'GITHUB_SHA', 'GITHUB_REF',
          'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_WORKFLOW_REF', 'GITHUB_WORKFLOW', 'RUNNER_ENVIRONMENT']) {
          if (typeof env[key] === 'string') isolated[key] = env[key];
        }
      }
      if (destination === 'promotion') {
        isolated.NODE_AUTH_TOKEN = env.NPM_PROMOTION_TOKEN;
        isolated.npm_config_userconfig = join(home, 'promotion.npmrc');
      }
      try {
        const result = await run(program, args, { cwd: program === 'npm' ? home : root, env: isolated, shell: false,
          encoding: 'buffer', timeout: 120000, maxBuffer: 128 * 1024 * 1024 });
        if (!result || (result.exitCode !== undefined && result.exitCode !== 0)) reject('command-failed');
        return bytes(result.stdout);
      } catch { reject('command-failed'); }
    };
    const git = async args => (await command('git', args)).toString('utf8').trim();
    const checkSource = async () => {
      if (await git(['rev-parse', 'HEAD']) !== config.source.commit ||
          await git(['rev-parse', 'HEAD^{tree}']) !== config.source.tree ||
          await git(['rev-parse', `${config.ref}^{commit}`]) !== config.source.commit ||
          await git(['status', '--porcelain', '--untracked-files=all'])) reject('source-identity-mismatch');
    };
    await checkSource();
    const common = await realpath(await git(['rev-parse', '--path-format=absolute', '--git-common-dir']));
    const owned = join(common, 'gentle-checks');
    const ownedPath = async (path, base) => {
      if (typeof path !== 'string' || !isAbsolute(path) || path !== resolve(path) || !within(base, path) ||
          await realpath(path) !== path) reject('invalid-path-ownership');
      return path;
    };
    const preflight = await ownedPath(config.preflightDirectory, owned);
    const core = await ownedPath(config.coreDirectory, within(owned, config.coreDirectory ?? '') ? owned : root);
    const readOwned = async (path, base) => {
      await ownedPath(path, base);
      const result = await readFile(path);
      if (!result.length) reject('empty-artifact');
      return result;
    };
    const evidence = decode(await readOwned(join(preflight, 'preflight-evidence.json'), preflight));
    if (evidence.schema !== 'engram.release-preflight/v1' || evidence.status !== 'passed' ||
        evidence.version !== version || evidence.installerVersion !== version ||
        evidence.source?.commit !== config.source.commit || evidence.source?.tree !== config.source.tree ||
        !digest.test(evidence.contractDigest ?? '') || !digest.test(evidence.npmDigest ?? '') ||
        typeof evidence.npmFilename !== 'string' || basename(evidence.npmFilename) !== evidence.npmFilename ||
        !evidence.npmFilename.endsWith('.tgz')) reject('invalid-preflight-evidence');
    const receiptNames = ['installer', 'go', 'pi', 'sdk-host', 'capture', 'pack'];
    if (!Array.isArray(evidence.receipts) || evidence.receipts.length !== receiptNames.length) reject('invalid-preflight-receipts');
    for (const name of receiptNames) {
      const entries = evidence.receipts.filter(entry => entry.name === name), receipt = entries[0];
      if (entries.length !== 1 || !(receipt.status === 'passed' && receipt.exitCode === 0 ||
          name === 'go' && receipt.status === 'accepted-baseline-failure' && receipt.exitCode === 1)) reject('invalid-preflight-receipts');
      const log = await readOwned(join(preflight, `${name}.log.json`), preflight);
      if (sha(log) !== receipt.logDigest) reject('preflight-receipt-mismatch');
      const result = decode(log);
      if (typeof result.stdout !== 'string' || typeof result.stderr !== 'string') reject('invalid-preflight-receipts');
      if (name === 'pack') {
        const packed = decode(result.stdout), entry = packed?.[0];
        if (!Array.isArray(packed) || packed.length !== 1 || entry?.name !== config.packageName ||
            entry.version !== version || entry.filename !== evidence.npmFilename) reject('invalid-preflight-pack');
      }
    }
    const contractBytes = await readOwned(join(preflight, 'contract-manifest.json'), preflight);
    const npmBytes = await readOwned(join(preflight, 'npm', evidence.npmFilename), preflight);
    if (sha(contractBytes) !== evidence.contractDigest || sha(npmBytes) !== evidence.npmDigest) reject('preflight-byte-mismatch');
    const expected = [...archiveNames(version), 'checksums.txt'];
    if (!Array.isArray(config.coreAssets) || config.coreAssets.length !== expected.length) reject('invalid-core-file-list');
    const paths = new Set(), assets = [];
    for (const name of expected) {
      const matching = config.coreAssets.filter(asset => asset?.name === name);
      if (matching.length !== 1 || basename(matching[0].path ?? '') !== name || paths.has(matching[0].path)) reject('invalid-core-file-list');
      paths.add(matching[0].path);
      assets.push({ name, bytes: await readOwned(matching[0].path, core) });
    }
    if (basename(config.formulaPath ?? '') !== 'engram.rb' || paths.has(config.formulaPath)) reject('invalid-formula-path');
    const formula = await readOwned(config.formulaPath, core);
    assets.push({ name: 'engram.rb', bytes: formula });
    const checksumLines = assets.find(asset => asset.name === 'checksums.txt').bytes.toString('utf8').trimEnd().split('\n');
    if (checksumLines.length !== 6 || archiveNames(version).some(name => {
      const matches = checksumLines.filter(line => line === `${sha(assets.find(asset => asset.name === name).bytes)}  ${name}`);
      return matches.length !== 1;
    })) reject('invalid-core-checksums');
    const artifacts = { source: config.source, contractBytes, contractDigest: evidence.contractDigest, npmBytes, coreAssets: assets };
    const identity = buildArtifactIdentity(artifacts);
    const carrier = jsonBytes({ schema: 'engram.release-identity/v1', version,
      sourceCommit: identity.sourceCommit, sourceTree: identity.sourceTree, contractDigest: identity.contractDigest,
      npmDigest: identity.npmDigest, coreDigest: identity.coreDigest,
      contractBytes: contractBytes.toString('base64'), coreManifestBytes: identity.coreManifestBytes.toString('base64') });
    let census;
    const queries = createDestinationCliQueries({ packageName: config.packageName, repository: config.repository,
      run: async (program, args) => {
        const stdout = await command(program, args);
        if (program === 'gh') census = decode(stdout);
        return { stdout: stdout.toString('utf8') };
      } });
    // Freeze once, after all local input/receipt/credential checks, before npm can create owned cache files.
    const frozen = join(owned, `publisher-${config.attemptId}`);
    await mkdir(frozen);
    home = join(frozen, 'home'); await mkdir(home);
    await writeFile(join(home, 'global.npmrc'), '');
    npmConfig = join(home, 'staging.npmrc'); await writeFile(npmConfig, 'registry=https://registry.npmjs.org/\n');
    await writeFile(join(home, 'promotion.npmrc'), 'registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n');
    await writeFile(join(frozen, 'candidate.tgz'), npmBytes, { flag: 'wx', mode: 0o444 });
    await writeFile(join(frozen, carrierName), carrier, { flag: 'wx', mode: 0o444 });
    for (const asset of assets) await writeFile(join(frozen, asset.name), asset.bytes, { flag: 'wx', mode: 0o444 });
    const request = destination => ({ destination, version, attemptId: config.attemptId });
    const npmCensus = await queries.npm(request('npm')), coreCensus = await queries.core(request('core'));
    if (npmCensus.state === 'unknown' || coreCensus.state === 'unknown') reject('unverified-destination');
    const releases = census.flat().filter(release => release.tag_name === `v${version}`);
    if (releases.length > 1) reject('ambiguous-release');
    let release = releases[0];
    const validateRelease = value => {
      if (objectId.test(value?.target_commitish ?? '') && value.target_commitish !== config.source.commit) reject('immutable-mismatch:release-target', true);
      if (!value || value.tag_name !== `v${version}` || value.target_commitish !== config.source.commit ||
          !Number.isSafeInteger(value.id) || value.id <= 0 || typeof value.draft !== 'boolean' || !Array.isArray(value.assets)) reject('unverified-release-target');
      const seen = new Set();
      for (const asset of value.assets) {
        if (!asset || !Number.isSafeInteger(asset.id) || asset.id <= 0 || typeof asset.name !== 'string' ||
            seen.has(asset.name) || !Number.isSafeInteger(asset.size) || asset.size <= 0 ||
            ![carrierName, ...assets.map(a => a.name)].includes(asset.name)) reject('invalid-release-assets');
        seen.add(asset.name);
      }
    };
    const remoteAsset = async asset => {
      const result = await command('gh', ['api', `repos/${config.repository}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream']);
      if (result.length !== asset.size) reject('remote-asset-size-mismatch', true);
      return result;
    };
    const verifyRelease = async value => {
      validateRelease(value);
      const metadata = value.assets.find(asset => asset.name === carrierName);
      if (!metadata) reject('missing-identity-carrier');
      if (!(await remoteAsset(metadata)).equals(carrier)) reject('immutable-mismatch:carrier', true);
      for (const asset of value.assets.filter(asset => asset.name !== carrierName)) {
        if (!(await remoteAsset(asset)).equals(assets.find(local => local.name === asset.name).bytes)) reject('immutable-mismatch:core', true);
      }
      if (!value.draft && assets.some(asset => !value.assets.some(remote => remote.name === asset.name))) reject('incomplete-published-core');
    };
    if (release) await verifyRelease(release);
    if (npmCensus.state === 'present' && !release) reject('missing-identity-carrier');
    if (npmCensus.state === 'present') {
      const observation = join(frozen, 'observation'); await mkdir(observation);
      const packed = decode(await command('npm', ['pack', `${config.packageName}@${version}`, '--ignore-scripts', '--json', '--pack-destination', observation]));
      const entry = packed?.[0];
      if (!Array.isArray(packed) || packed.length !== 1 || entry?.version !== version || typeof entry.filename !== 'string' ||
          basename(entry.filename) !== entry.filename || !entry.filename.endsWith('.tgz') || entry.name !== config.packageName) reject('invalid-remote-npm-pack');
      if (sha(await readOwned(join(observation, entry.filename), observation)) !== identity.npmDigest) reject('immutable-mismatch:npm', true);
    }
    const present = destination => ({ state: 'present', attemptId: config.attemptId, version,
      sourceCommit: identity.sourceCommit, contractDigest: identity.contractDigest, contentDigest: identity[`${destination}Digest`] });
    const absent = { state: 'absent', attemptId: config.attemptId, version };
    const planned = planPublicationAttempt({ version, attemptId: config.attemptId, artifacts,
      destinations: { npm: npmCensus.state === 'present' ? present('npm') : absent, core: release && !release.draft ? present('core') : absent },
      gates: { goTests: true, piTests: true, packageChecks: true, profileParity: true, semanticContract: true, trustedPublisher: config.trustedPublisher } });
    if (planned.plan.status !== 'ready') reject(planned.plan.reason, planned.plan.correctiveVersionRequired);
    await checkSource();
    const mutate = async (program, args, destination) => {
      mutating = true;
      return command(program, args, destination);
    };
    if (!release) {
      await mutate('gh', ['release', 'create', `v${version}`, '--repo', config.repository, '--target', config.source.commit,
        '--draft', '--title', `v${version}`, '--notes', 'Identity reservation; core artifacts are not published.']);
      durablePoint = 'draft-reservation';
      release = decode(await command('gh', ['api', `repos/${config.repository}/releases/tags/v${version}`]));
      validateRelease(release);
      if (!release.draft || release.assets.length) reject('reservation-race');
      await mutate('gh', ['release', 'upload', `v${version}`, join(frozen, carrierName), '--repo', config.repository]);
      durablePoint = 'identity-carrier-upload';
      release = decode(await command('gh', ['api', `repos/${config.repository}/releases/tags/v${version}`]));
      await verifyRelease(release);
      if (!release.draft) reject('reservation-race');
    }
    completed.push('identity-reservation'); durablePoint = 'identity-reservation';
    for (const action of planned.plan.actions) {
      if (action === 'publish-npm-staging') {
        if (sha(await readFile(join(frozen, 'candidate.tgz'))) !== identity.npmDigest) reject('frozen-byte-mismatch');
        await mutate('npm', ['publish', join(frozen, 'candidate.tgz'), '--tag', planned.plan.stagingTag, '--provenance', '--access', 'public'], 'staging');
        completed.push('npm-staging'); durablePoint = 'npm-staging';
      } else if (action === 'set-npm-staging-tag') {
        await mutate('npm', ['dist-tag', 'add', `${config.packageName}@${version}`, planned.plan.stagingTag], 'promotion');
        completed.push('npm-staging'); durablePoint = 'npm-staging';
      } else if (action === 'publish-core') {
        for (const asset of assets) {
          if (sha(await readFile(join(frozen, asset.name))) !== sha(asset.bytes)) reject('frozen-byte-mismatch');
          if (!release.assets.some(remote => remote.name === asset.name)) {
            await mutate('gh', ['release', 'upload', `v${version}`, join(frozen, asset.name), '--repo', config.repository]);
            durablePoint = `core-upload:${asset.name}`;
          }
        }
        // Fresh echo verifies every uploaded byte before exposing the draft as a release.
        release = decode(await command('gh', ['api', `repos/${config.repository}/releases/tags/v${version}`]));
        await verifyRelease(release);
        if (!release.draft || assets.some(asset => !release.assets.some(remote => remote.name === asset.name))) reject('incomplete-core-upload');
        await mutate('gh', ['release', 'edit', `v${version}`, '--repo', config.repository, '--draft=false', `--prerelease=${!stable}`]);
        completed.push('core'); durablePoint = 'core';
      } else if (action === 'promote-npm') {
        if (!completed.includes('core')) completed.push('core');
        if (stable) {
          const tap = 'repos/Gentleman-Programming/homebrew-tap';
          const repository = decode(await command('gh', ['api', tap], 'tap'));
          if (repository?.full_name !== 'Gentleman-Programming/homebrew-tap') reject('invalid-tap-metadata');
          const listing = decode(await command('gh', ['api', `${tap}/contents/Formula`], 'tap'));
          if (!Array.isArray(listing) || listing.length >= 1000 || listing.some(entry => !entry || typeof entry.name !== 'string' || typeof entry.type !== 'string')) reject('invalid-tap-metadata');
          const matches = listing.filter(entry => entry.name === 'engram.rb');
          if (matches.length > 1 || matches.some(entry => entry.type !== 'file')) reject('invalid-tap-metadata');
          let current;
          if (matches.length) {
            current = decode(await command('gh', ['api', `${tap}/contents/Formula/engram.rb`], 'tap'));
            if (current.type !== 'file' || current.encoding !== 'base64' || typeof current.content !== 'string' || !/^[a-f0-9]{40}$/.test(current.sha ?? '')) reject('invalid-tap-metadata');
            const encoded = current.content.replace(/\n/g, '');
            const content = Buffer.from(encoded, 'base64');
            if (content.toString('base64') !== encoded) reject('invalid-tap-metadata');
            if (createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex') !== current.sha) reject('invalid-tap-metadata');
            if (content.equals(formula)) { completed.push('homebrew'); current = { identical: true }; }
          }
          if (!current?.identical) {
            await mutate('gh', ['api', `${tap}/contents/Formula/engram.rb`, '--method', 'PUT', '-f', `message=chore: update engram formula to v${version}`,
              '-f', `content=${formula.toString('base64')}`, ...(current ? ['-f', `sha=${current.sha}`] : [])], 'tap');
            completed.push('homebrew');
          }
          durablePoint = 'homebrew';
        }
        await mutate('npm', ['dist-tag', 'add', `${config.packageName}@${version}`, planned.plan.promotionTag], 'promotion');
        completed.push('npm-promotion'); durablePoint = 'npm-promotion';
      } else reject('unsupported-planner-action');
    }
    return { status: 'completed', correctiveVersionRequired: false, completed, durablePoint };
  } catch (error) {
    return { status: mutating ? 'failed' : 'blocked', reason: error.reason ?? 'invalid-evidence',
      correctiveVersionRequired: error.correctiveVersionRequired === true, completed, durablePoint };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help') process.stdout.write(help);
    else {
      if (args.length !== 2 || args[0] !== '--config' || !isAbsolute(args[1])) reject('invalid-options');
      const result = await runReleasePublisher(decode(await readFile(args[1])), { root: fileURLToPath(new URL('../../../', import.meta.url)) });
      if (result.status !== 'completed') reject('publication-not-completed');
      process.stdout.write('release publication completed\n');
    }
  } catch { process.stderr.write('release publication blocked or failed\n'); process.exitCode = 1; }
}
