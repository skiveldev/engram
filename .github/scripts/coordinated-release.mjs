#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReleaseVersionAgreement } from '../../plugin/pi/release/version-contract.mjs';
const help = 'Usage: node .github/scripts/coordinated-release.mjs [--help]\nEnvironment: RELEASE_REF=refs/tags/vSEMVER ENGRAM_PI_SDK_VERSION=SEMVER ENGRAM_TRUSTED_PUBLISHER_CONFIRMED=true GITHUB_RUN_ID GITHUB_RUN_ATTEMPT GITHUB_REPOSITORY; publisher credentials required.\n';
const inside = (base, path) => { const p = relative(base, path); return p !== '' && !p.startsWith('..') && !isAbsolute(p); };
function execute(command, args, options) {
  const result = spawnSync(command, args, { ...options, shell: false, encoding: 'utf8', timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  return { exitCode: result.error || result.signal ? 1 : result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
/** Offline runner injection is not evidence of live release readiness. No subprocess output is logged. */
export async function run({ root, env = process.env, run: command = execute }) {
  try {
    root = resolve(root);
    const metadata = JSON.parse(await readFile(join(root, 'plugin/pi/package.json'), 'utf8'));
    const version = assertReleaseVersionAgreement({ route: 'core', releaseRef: env.RELEASE_REF, packageVersion: metadata.version, installerVersion: metadata.version });
    assertReleaseVersionAgreement({ route: 'core', releaseRef: `refs/tags/v${env.ENGRAM_PI_SDK_VERSION}`, packageVersion: env.ENGRAM_PI_SDK_VERSION, installerVersion: env.ENGRAM_PI_SDK_VERSION });
    const attemptId = `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
    if (env.ENGRAM_TRUSTED_PUBLISHER_CONFIRMED !== 'true' || !/^[0-9]+$/.test(env.GITHUB_RUN_ID ?? '') || !/^[0-9]+$/.test(env.GITHUB_RUN_ATTEMPT ?? '') || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(attemptId) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? '')) throw Error();
    if (await realpath(root) !== root) throw Error();
    const isolated = { PATH: env.PATH ?? process.env.PATH, NO_UPDATE_NOTIFIER: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    for (const key of ['GOROOT', 'GOMODCACHE']) if (env[key]) isolated[key] = env[key];
    const call = async (program, args, credentials = false) => {
      const result = await command(program, args, { cwd: root, env: credentials ? { ...env, ...isolated } : { ...isolated }, shell: false });
      if (result?.exitCode !== 0 || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') throw Error();
      return result.stdout.trim();
    };
    const git = args => call('git', args);
    const identity = async () => {
      const commit = await git(['rev-parse', 'HEAD']), tree = await git(['rev-parse', 'HEAD^{tree}']);
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(tree) || await git(['status', '--porcelain', '--untracked-files=all']) || await git(['rev-parse', `${env.RELEASE_REF}^{commit}`]) !== commit) throw Error();
      return { commit, tree };
    };
    const source = await identity(), common = await realpath(await git(['rev-parse', '--path-format=absolute', '--git-common-dir']));
    const owned = join(common, 'gentle-checks'); await mkdir(owned, { recursive: true });
    if (await realpath(owned) !== owned) throw Error();
    const work = join(owned, `train-${attemptId}`); await mkdir(work);
    Object.assign(isolated, { HOME: work, TMPDIR: work, GOMODCACHE: join(work, 'go-mod-cache'), GOCACHE: join(work, 'go-cache'), npm_config_cache: join(work, 'npm-cache') });
    await call('go', ['mod', 'tidy', '-diff']);
    await call('go', ['mod', 'download']);
    const sdkPrefix = join(work, 'sdk'); await mkdir(sdkPrefix);
    await call('npm', ['install', '--prefix', sdkPrefix, '--ignore-scripts', '--no-package-lock', `@earendil-works/pi-coding-agent@${env.ENGRAM_PI_SDK_VERSION}`]);
    const sdkRoot = join(sdkPrefix, 'node_modules/@earendil-works/pi-coding-agent');
    const preflightDirectory = join(owned, `preflight-${attemptId}`);
    await call(process.execPath, [join(root, 'plugin/pi/release/release-preflight.mjs'), '--ref', env.RELEASE_REF, '--sdk-root', sdkRoot, '--output', preflightDirectory]);
    const receiptPath = join(preflightDirectory, 'preflight-evidence.json'), receiptBytes = await readFile(receiptPath), receipt = JSON.parse(receiptBytes);
    if (receipt.schema !== 'engram.release-preflight/v1' || receipt.status !== 'passed' || receipt.version !== version || receipt.source?.commit !== source.commit || receipt.source?.tree !== source.tree) throw Error();
    const coreDirectory = join(work, 'core'), dist = relative(root, coreDirectory);
    if (isAbsolute(dist) || resolve(root, dist) !== coreDirectory || !inside(owned, coreDirectory) || await realpath(dirname(coreDirectory)) !== dirname(coreDirectory)) throw Error();
    const original = await readFile(join(root, '.goreleaser.yaml'), 'utf8');
    if (/^dist:/m.test(original) || (original.match(/^    skip_upload: auto$/gm) ?? []).length !== 1) throw Error();
    const configPath = join(work, 'goreleaser.yaml');
    await writeFile(configPath, `dist: ${JSON.stringify(dist)}\n` + original.replace('    skip_upload: auto', '    skip_upload: true'), { flag: 'wx', mode: 0o444 });
    await call('goreleaser', ['release', '--skip=publish,announce,after', '--clean', '--config', configPath]);
    // Enumerate only this attempt's fresh output, never source or dependency trees.
    const files = []; let entries = 0;
    const walk = async (directory, depth = 0) => {
      if (depth > 8 || await realpath(directory) !== directory) throw Error();
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++entries > 4096 || entry.isSymbolicLink()) throw Error();
        const path = join(directory, entry.name);
        if (!inside(coreDirectory, path) || await realpath(path) !== path) throw Error();
        if (entry.isDirectory()) await walk(path, depth + 1);
        else if (entry.isFile()) files.push(path); else throw Error();
      }
    };
    await walk(coreDirectory);
    const names = ['linux', 'darwin', 'windows'].flatMap(os => ['amd64', 'arm64'].map(arch => `engram_${version}_${os}_${arch}.${os === 'windows' ? 'zip' : 'tar.gz'}`)).concat('checksums.txt');
    const select = async name => {
      const matches = files.filter(path => basename(path) === name);
      if (matches.length !== 1 || !(await readFile(matches[0])).length) throw Error();
      return matches[0];
    };
    const coreAssets = []; for (const name of names) coreAssets.push({ name, path: await select(name) });
    const formulaPath = await select('engram.rb'), after = await identity();
    if (after.commit !== source.commit || after.tree !== source.tree || !(await readFile(receiptPath)).equals(receiptBytes)) throw Error();
    const publisherPath = join(work, 'publisher.json');
    await writeFile(publisherPath, JSON.stringify({ version, ref: env.RELEASE_REF, attemptId, source, preflightDirectory, coreDirectory, coreAssets, formulaPath, repository: env.GITHUB_REPOSITORY, packageName: metadata.name, trustedPublisher: env.ENGRAM_TRUSTED_PUBLISHER_CONFIRMED === 'true' }) + '\n', { flag: 'wx', mode: 0o444 });
    await call(process.execPath, [join(root, 'plugin/pi/release/release-publisher.mjs'), '--config', publisherPath], true);
    return { exitCode: 0 };
  } catch { return { exitCode: 1 }; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--help') process.stdout.write(help);
  else if (process.argv.length !== 2) { process.stderr.write('coordinated release failed\n'); process.exitCode = 1; }
  else { const result = await run({ root: fileURLToPath(new URL('../../', import.meta.url)) }); process.exitCode = result.exitCode; if (result.exitCode) process.stderr.write('coordinated release failed\n'); else process.stdout.write('coordinated release completed\n'); }
}
