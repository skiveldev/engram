import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../../.github/scripts/coordinated-release.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
const metadata = await readFile(join(root, 'plugin/pi/package.json'));
const originalConfig = await readFile(join(root, '.goreleaser.yaml'), 'utf8');
async function fixture(failure) {
  const parent = join(common, 'gentle-checks/t4-workflow-test'); await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, 'case-')), calls = [];
  const env = { RELEASE_REF: 'refs/tags/v0.2.0', ENGRAM_PI_SDK_VERSION: '0.62.0', ENGRAM_TRUSTED_PUBLISHER_CONFIRMED: 'true', GITHUB_RUN_ID: '123456789012', GITHUB_RUN_ATTEMPT: dir.split('/').at(-1).split('').map(c => c.charCodeAt(0)).join(''), GITHUB_REPOSITORY: 'Gentleman-Programming/engram', GH_TOKEN: 'secret', NPM_PROMOTION_TOKEN: 'promotion-secret', HOMEBREW_TAP_TOKEN: 'tap-secret' };
  const fake = async (command, args, options) => {
    calls.push({ command, args, options });
    if (failure === 'preflight' && args.includes('--sdk-root') || failure === 'publisher' && command === process.execPath && args.includes('--config')) return { exitCode: 1, stdout: 'secret', stderr: 'secret' };
    if (command === 'git') return { exitCode: 0, stdout: args.includes('--git-common-dir') ? common : args[0] === 'status' ? '' : args.at(-1).includes('tree') ? source.tree : failure === 'changed' && calls.some(x => x.command === 'goreleaser') ? 'c'.repeat(40) : source.commit, stderr: '' };
    if (args.includes('--sdk-root')) {
      const out = args[args.indexOf('--output') + 1]; await mkdir(out);
      await writeFile(join(out, 'preflight-evidence.json'), JSON.stringify({ schema: 'engram.release-preflight/v1', status: failure === 'receipt' ? 'failed' : 'passed', version: '0.2.0', source }));
    }
    if (command === 'goreleaser') {
      const config = await readFile(args.at(-1), 'utf8');
      const dist = resolve(root, JSON.parse(config.match(/^dist: (.+)$/m)[1]));
      assert.equal(relative(root, dist).startsWith('/'), false);
      assert.equal(config.slice(config.indexOf('\n') + 1), originalConfig.replace('    skip_upload: auto', '    skip_upload: true'));
      await mkdir(join(dist, 'Formula'), { recursive: true });
      for (const os of ['linux', 'darwin', 'windows']) for (const arch of ['amd64', 'arm64']) await writeFile(join(dist, `engram_0.2.0_${os}_${arch}.${os === 'windows' ? 'zip' : 'tar.gz'}`), 'bytes');
      await writeFile(join(dist, 'checksums.txt'), 'checksums'); await writeFile(join(dist, 'Formula/engram.rb'), 'formula');
      if (failure === 'duplicate') await writeFile(join(dist, 'engram.rb'), 'duplicate');
    }
    if (args.includes('--config') && command === process.execPath) {
      const config = JSON.parse(await readFile(args.at(-1), 'utf8'));
      assert.deepEqual(config.source, source); assert.equal(config.coreAssets.length, 7);
      assert.equal(config.packageName, 'gentle-engram'); assert.equal(config.trustedPublisher, true);
      assert.ok(!JSON.stringify(config).includes('secret'));
    }
    if (command !== process.execPath || !args.includes('--config')) for (const key of ['GH_TOKEN', 'NPM_PROMOTION_TOKEN', 'HOMEBREW_TAP_TOKEN']) assert.equal(options.env[key], undefined);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { env, calls, fake };
}
test('invalid refs, missing SDK pin and unconfirmed trust reject before commands', async () => {
  for (const patch of [{ RELEASE_REF: 'refs/heads/v0.2.0' }, { RELEASE_REF: 'v0.2.0' }, { RELEASE_REF: 'refs/tags/pi-v0.2.0' }, { RELEASE_REF: 'refs/tags/v01.2.0' }, { ENGRAM_PI_SDK_VERSION: '' }, { ENGRAM_PI_SDK_VERSION: 'latest' }, { ENGRAM_TRUSTED_PUBLISHER_CONFIRMED: 'false' }]) {
    const f = await fixture(); assert.deepEqual(await run({ root, env: { ...f.env, ...patch }, run: f.fake }), { exitCode: 1 }); assert.equal(f.calls.length, 0);
  }
});
test('one preflight and one core build precede exact publisher CLI; source stays unchanged', async () => {
  const f = await fixture(); assert.deepEqual(await run({ root, env: f.env, run: f.fake }), { exitCode: 0 });
  const preflight = f.calls.filter(x => x.args.includes('--sdk-root')), core = f.calls.filter(x => x.command === 'goreleaser'), publisher = f.calls.filter(x => x.command === process.execPath && x.args.includes('--config'));
  assert.equal(preflight.length, 1); assert.equal(core.length, 1); assert.equal(publisher.length, 1);
  assert.equal(preflight[0].command, process.execPath); assert.ok(preflight[0].args[0].endsWith('/release/release-preflight.mjs'));
  assert.ok(publisher[0].args[0].endsWith('/release/release-publisher.mjs')); assert.deepEqual(core[0].args.slice(0, 4), ['release', '--skip=publish,announce,after', '--clean', '--config']);
  assert.ok(f.calls.indexOf(preflight[0]) < f.calls.indexOf(core[0]) && f.calls.indexOf(core[0]) < f.calls.indexOf(publisher[0]));
  assert.equal(f.calls.filter(x => x.command === 'npm').length, 1);
  assert.ok(f.calls.find(x => x.command === 'npm').args.includes('@earendil-works/pi-coding-agent@0.62.0'));
  assert.ok(f.calls.findIndex(x => x.args.includes('-diff')) < f.calls.findIndex(x => x.args.includes('download')));
  assert.deepEqual(await readFile(join(root, 'plugin/pi/package.json')), metadata);
  assert.equal(await readFile(join(root, '.goreleaser.yaml'), 'utf8'), originalConfig);
});
test('workflow has one per-version train, pinned runtimes and explicit publisher permissions', async () => {
  const yaml = await readFile(join(root, '.github/workflows/release.yml'), 'utf8');
  for (const text of ['workflow_dispatch:', 'release_ref:', 'group: coordinated-release-${{ inputs.release_ref || github.ref }}', 'cancel-in-progress: false', 'permissions:\n  contents: read', 'contents: write\n      id-token: write', 'persist-credentials: false', 'go-version: "1.25.10"', 'node-version: "24"', 'npm install -g npm@11.5.1', 'args: --version', 'run: node .github/scripts/coordinated-release.mjs']) assert.ok(yaml.includes(text), text);
  assert.equal((yaml.match(/run: node \.github\/scripts\/coordinated-release.mjs/g) ?? []).length, 1);
  assert.ok(yaml.includes('actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803'));
  assert.ok(yaml.includes('actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16'));
  assert.ok(yaml.includes('actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444'));
  assert.ok(!yaml.includes('args: release') && !yaml.includes('${{ github.run_id }}'));
  assert.ok(!/^\s+run:.*\$\{\{/m.test(yaml));
});
test('CLI help is passive; unknown options and publisher failures are opaque', async () => {
  const script = join(root, '.github/scripts/coordinated-release.mjs');
  const help = spawnSync(process.execPath, [script, '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0); assert.equal(help.stderr, ''); assert.ok(help.stdout.startsWith('Usage: node .github/scripts/coordinated-release.mjs [--help]\n'));
  const bad = spawnSync(process.execPath, [script, '--unknown'], { cwd: root, encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.equal(bad.stdout, ''); assert.equal(bad.stderr, 'coordinated release failed\n');
  const f = await fixture('publisher'); assert.deepEqual(await run({ root, env: f.env, run: f.fake }), { exitCode: 1 });
});
test('failed preflight, changed source and ambiguous owned formula never publish', async () => {
  for (const failure of ['preflight', 'receipt', 'changed', 'duplicate']) { const f = await fixture(failure); assert.deepEqual(await run({ root, env: f.env, run: f.fake }), { exitCode: 1 }); assert.equal(f.calls.some(x => x.command === process.execPath && x.args.includes('--config')), false); if (failure === 'preflight' || failure === 'receipt') assert.equal(f.calls.some(x => x.command === 'goreleaser'), false); }
});
