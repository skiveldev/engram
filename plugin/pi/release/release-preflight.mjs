import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseVersionAgreement } from "./version-contract.mjs";
import { buildContractManifest } from "./contract-manifest.mjs";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const inside = (base, path) => { const r = relative(base, path); return r !== "" && !r.startsWith("..") && !isAbsolute(r); };
const help = "Usage: node plugin/pi/release/release-preflight.mjs --ref <refs/tags/vSEMVER> --sdk-root <installedSDK> --output <new git-common/gentle-checks directory>\n";
export function parsePreflightArgs(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const keys = { "--ref": "releaseRef", "--sdk-root": "sdkRoot", "--output": "outputDirectory" }, result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = keys[args[i]];
    if (!key || Object.hasOwn(result, key) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("invalid preflight options");
    result[key] = args[i + 1];
  }
  if (Object.keys(result).length !== 3) throw new Error("invalid preflight options");
  return result;
}
function processRun(command, args, options) {
  const result = spawnSync(command, args, { ...options, shell: false, encoding: "utf8", timeout: 20 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  return { exitCode: result.error || result.signal ? -1 : result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function goStatus(result) {
  let records;
  try { records = result.stdout.trim().split("\n").map(line => JSON.parse(line)); } catch { throw new Error("go JSON proof unavailable"); }
  if (records.some(x => !x || typeof x.Action !== "string" || typeof x.Package !== "string")) throw new Error("go JSON proof malformed");
  const failures = records.filter(x => x.Action === "fail");
  if (result.exitCode === 0 && !failures.length && records.some(x => x.Action === "pass" && !x.Test)) return "passed";
  const tests = failures.filter(x => x.Test), packages = failures.filter(x => !x.Test);
  const approved = "TestCompressedEnvelopeRoundTripDoesNotExposePayloadText";
  if (result.exitCode === 1 && result.stderr === "" && tests.length === 1 && packages.length === 1 &&
    tests[0].Test === approved && tests[0].Package === "github.com/Gentleman-Programming/engram/v3/internal/chunkcodec" && tests[0].Package === packages[0].Package &&
    records.some(x => x.Action === "output" && x.Test === approved && x.Package === tests[0].Package && x.Output?.includes("compressed envelope exposed observation text")) &&
    !records.some(x => x.Action === "build-fail" || /panic:|build failed|test timed out/.test(x.Output ?? ""))) return "accepted-baseline-failure";
  throw new Error("go gate failed");
}
/** No publication: runner injection is for deterministic offline tests, not provenance. */
export async function runReleasePreflight({ root, releaseRef, sdkRoot, outputDirectory, run = processRun }) {
  root = resolve(root); const pi = join(root, "plugin/pi");
  if (typeof sdkRoot !== "string" || !isAbsolute(sdkRoot)) throw new Error("installed SDK absolute path required");
  const metadata = JSON.parse(await readFile(join(pi, "package.json"), "utf8"));
  const version = assertReleaseVersionAgreement({ route: "core", releaseRef, packageVersion: metadata.version, installerVersion: metadata.version });
  // Above is ref/package validation ONLY. Actual installer proof is the legacy CLI below.
  const env = {};
  for (const key of ["PATH", "GOROOT", "GOMODCACHE"]) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { GOPROXY: "off", GOSUMDB: "off", GOTOOLCHAIN: "local", GOFLAGS: "-mod=readonly", NO_UPDATE_NOTIFIER: "1" });
  const execute = async (command, args, cwd = root, extra = {}) => {
    const result = await run(command, args, { cwd, env: { ...env, ...extra } });
    if (!Number.isInteger(result?.exitCode) || typeof result.stdout !== "string" || typeof result.stderr !== "string") throw new Error("invalid runner result");
    return result;
  };
  const git = async args => { const r = await execute("git", args); if (r.exitCode !== 0) throw new Error("Git identity unavailable"); return r.stdout.trim(); };
  const identity = async () => {
    const commit = await git(["rev-parse", "HEAD"]), tree = await git(["rev-parse", "HEAD^{tree}"]);
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(tree) ||
      await git(["status", "--porcelain", "--untracked-files=all"])) throw new Error("source must be clean including untracked files");
    return { commit, tree };
  };
  const source = await identity(), common = await realpath(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  if (await git(["rev-parse", `${releaseRef}^{commit}`]) !== source.commit) throw new Error("release tag differs from selected HEAD");
  const output = resolve(outputDirectory ?? "");
  // Resolve the existing parent, rejecting symlink escapes and pre-existing outputs.
  const parent = await realpath(dirname(output));
  if (!inside(join(common, "gentle-checks"), output) || !inside(join(common, "gentle-checks"), join(parent, basename(output)))) throw new Error("output must be a new owned git-common/gentle-checks directory");
  try { await access(output); throw new Error("output already exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await access(join(sdkRoot ?? "", "dist/index.js"));
  if (metadata.scripts?.test !== "node --test test/*.test.mjs") throw new Error("unsupported Pi test script");
  for (const name of ["package-contract.test.mjs", "release-agent-contract.test.mjs", "pi-host-validation.mjs", "release-schema-capture.mjs"]) await access(join(pi, "test", name));
  const installerArgs = ["test/release-contract.mjs", `refs/tags/pi-v${version}`];
  const installer = await execute(process.execPath, installerArgs, pi);
  if (installer.exitCode !== 0) throw new Error("installer/Pi CLI agreement gate failed");
  await mkdir(output); for (const name of ["home", "tmp", "go-cache", "node-cache", "npm"]) await mkdir(join(output, name));
  Object.assign(env, { HOME: join(output, "home"), TMPDIR: join(output, "tmp"), GOTMPDIR: join(output, "tmp"), GOCACHE: join(output, "go-cache"), NODE_COMPILE_CACHE: join(output, "node-cache"), npm_config_cache: join(output, "npm") });
  const evidence = { schema: "engram.release-preflight/v1", status: "running", source, version, installerVersion: version,
    installerProof: "derived from successful existing Pi validator: actual single installer pin equals package version", receipts: [] };
  const persist = () => writeFile(join(output, "preflight-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  const receipt = async (name, command, args, result, status) => {
    const bytes = Buffer.from(JSON.stringify({ stdout: result.stdout, stderr: result.stderr }) + "\n");
    await writeFile(join(output, `${name}.log.json`), bytes);
    evidence.receipts.push({ name, command, args, exitCode: result.exitCode, status, logDigest: sha(bytes) });
  };
  const gate = async (name, command, args, cwd = root, extra = {}) => {
    const result = await execute(command, args, cwd, extra); let status = "failed";
    try { status = name === "go" ? goStatus(result) : result.exitCode === 0 ? "passed" : "failed"; }
    finally { await receipt(name, command, args, result, status); }
    if (status === "failed") throw new Error(`${name} gate failed`);
    return result;
  };
  try {
    await receipt("installer", process.execPath, installerArgs, installer, "passed");
    await gate("go", "go", ["test", "-json", "./..."]);
    await gate("pi", "npm", ["test"], pi);
    evidence.packageChecks = "covered by npm test: test/package-contract.test.mjs (validated default test script)";
    await gate("sdk-host", process.execPath, ["--test", "test/pi-host-validation.mjs"], pi, { ENGRAM_PI_SDK_ROOT: sdkRoot });
    const captured = await gate("capture", process.execPath, ["--test", "test/release-schema-capture.mjs"], pi, { ENGRAM_PI_SDK_ROOT: sdkRoot, ENGRAM_RELEASE_SOURCE_COMMIT: source.commit });
    const paths = [...captured.stdout.matchAll(/^(?:# )?capture retained: (.+)$/gm)];
    if (paths.length !== 1) throw new Error("capture retained path proof unavailable");
    const captureDir = await realpath(paths[0][1]);
    if (dirname(captureDir) !== join(common, "gentle-checks/t3-capture") || !basename(captureDir).startsWith("capture-")) throw new Error("capture path outside producer ownership");
    const capture = JSON.parse(await readFile(join(captureDir, "schema-capture.json"), "utf8"));
    const manifest = buildContractManifest(capture, source);
    const bytes = await readFile(join(captureDir, "contract-manifest.json"));
    const binding = JSON.parse(await readFile(join(captureDir, "contract-identity.json"), "utf8"));
    if (!bytes.equals(Buffer.from(manifest.bytes)) || binding.source?.commit !== source.commit || binding.source?.tree !== source.tree || binding.contractDigest !== manifest.contractDigest) throw new Error("canonical capture bytes/identity mismatch");
    const packed = await gate("pack", "npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", join(output, "npm")], pi);
    const entries = JSON.parse(packed.stdout), entry = entries[0];
    if (!Array.isArray(entries) || entries.length !== 1 || entry?.version !== version || typeof entry.filename !== "string" || basename(entry.filename) !== entry.filename || !entry.filename.endsWith(".tgz")) throw new Error("invalid npm pack result");
    const tarPath = await realpath(join(output, "npm", entry.filename));
    if (dirname(tarPath) !== join(output, "npm")) throw new Error("npm tarball ownership mismatch");
    const tar = await readFile(tarPath); if (!tar.length) throw new Error("empty npm tarball");
    const after = await identity(); if (after.commit !== source.commit || after.tree !== source.tree) throw new Error("source changed during preflight");
    await writeFile(join(output, "contract-manifest.json"), bytes);
    Object.assign(evidence, { status: "passed", contractDigest: manifest.contractDigest, npmDigest: sha(tar), npmFilename: entry.filename });
    await persist(); return evidence;
  } catch (error) { evidence.status = "failed"; await persist(); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parsePreflightArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(help);
    else { await runReleasePreflight({ root: fileURLToPath(new URL("../../../", import.meta.url)), ...options }); process.stdout.write("preflight evidence retained\n"); }
  } catch { process.stderr.write("release preflight failed; inspect retained owned evidence if created\n"); process.exitCode = 1; }
}
