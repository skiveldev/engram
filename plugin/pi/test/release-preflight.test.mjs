import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { runReleasePreflight, parsePreflightArgs } from "../release/release-preflight.mjs";
import { buildContractManifest } from "../release/contract-manifest.mjs";
import { PROFILE_AGENT, PI_EXTRAS } from "../release/canonical-contract.mjs";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
const source = { commit: "a".repeat(40), tree: "b".repeat(40) };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture(overrides = {}) {
  const owned = join(common, "gentle-checks/t4-preflight-owned"); await mkdir(owned, { recursive: true });
  const dir = await mkdtemp(join(owned, "test-"));
  const calls = [], input = { root, releaseRef: "refs/tags/v0.2.0", sdkRoot: dir, outputDirectory: join(dir, "output") };
  await mkdir(join(dir, "dist")); await writeFile(join(dir, "dist/index.js"), "// fake installed SDK");
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "git") return { exitCode: 0, stderr: "", stdout: args.includes("--git-common-dir") ? common : args[0] === "status" ? (overrides.dirty ? "?? runtime.go" : "") : args.at(-1).includes("tree") ? source.tree : overrides.badTag && args.at(-1).includes("refs/tags/") ? "c".repeat(40) : source.commit };
    if (overrides.fail?.(command, args)) return { exitCode: 1, stdout: "", stderr: "fixture failure" };
    let stdout = "", exitCode = 0;
    if (command === "go") { stdout = overrides.go ?? JSON.stringify({ Action: "pass", Package: "fixture" }) + "\n"; exitCode = overrides.go ? 1 : 0; }
    if (args.includes("test/release-schema-capture.mjs")) {
      const base = join(common, "gentle-checks/t3-capture"); await mkdir(base, { recursive: true });
      const captureDir = await mkdtemp(join(base, "capture-"));
      const tool = name => ({ name, inputSchema: { type: "object", properties: {} } });
      const capture = { schema: "engram.schema-capture/v2", source, mcp: PROFILE_AGENT.map(tool), pi: [...PROFILE_AGENT, ...PI_EXTRAS].map(tool) };
      const manifest = buildContractManifest(capture, source);
      await writeFile(join(captureDir, "schema-capture.json"), JSON.stringify({ ...capture, source: overrides.badSource ? { ...source, commit: "c".repeat(40) } : source }));
      await writeFile(join(captureDir, "contract-manifest.json"), manifest.bytes);
      await writeFile(join(captureDir, "contract-identity.json"), JSON.stringify({ source, contractDigest: manifest.contractDigest }));
      stdout = `TAP version 13\n# capture retained: ${captureDir}\n`;
    }
    if (command === "npm" && args[0] === "pack") {
      await writeFile(join(args.at(-1), "gentle-engram-0.2.0.tgz"), "exact packed bytes");
      stdout = JSON.stringify([{ filename: overrides.badPack ? "../escape.tgz" : "gentle-engram-0.2.0.tgz", version: "0.2.0" }]);
    }
    return { exitCode, stdout, stderr: "" };
  };
  return { input: { ...input, run }, calls };
}
test("core mismatch rejects before IO; existing Pi validator mapping proves installer", async () => {
  const f = await fixture(); await assert.rejects(runReleasePreflight({ ...f.input, releaseRef: "refs/tags/v9.0.0" }), /Release ref/);
  assert.equal(f.calls.length, 0); await assert.rejects(access(f.input.outputDirectory));
  const failed = await fixture({ fail: (_cmd, args) => args[0] === "test/release-contract.mjs" });
  await assert.rejects(runReleasePreflight(failed.input), /installer/);
  assert.deepEqual(failed.calls.filter(x => x.command !== "git").map(x => x.args), [["test/release-contract.mjs", "refs/tags/pi-v0.2.0"]]);
  await assert.rejects(access(failed.input.outputDirectory));
});
test("full ordered preflight freezes actual bytes and leaves request unchanged", async () => {
  const f = await fixture(), before = { ...f.input }; const result = await runReleasePreflight(f.input);
  assert.deepEqual(f.input, before); assert.equal(result.npmDigest, sha(Buffer.from("exact packed bytes")));
  assert.deepEqual(result.source, source); assert.equal(result.installerVersion, "0.2.0");
  assert.equal(result.receipts.find(x => x.name === "go").status, "passed");
  assert.equal(result.trustedPublisher, undefined); assert.equal(result.coreDigest, undefined);
  assert.deepEqual(f.calls.filter(x => x.command === "npm").map(x => x.args[0]), ["test", "pack"]);
  assert.equal(JSON.parse(await readFile(join(f.input.outputDirectory, "preflight-evidence.json"))).npmDigest, result.npmDigest);
});
test("gate failure retains failed receipt and never packs; bad capture binding blocks pack", async () => {
  for (const overrides of [{ fail: (cmd) => cmd === "npm" }, { fail: (_cmd, args) => args.includes("test/pi-host-validation.mjs") }, { badSource: true }]) {
    const f = await fixture(overrides); await assert.rejects(runReleasePreflight(f.input));
    assert.ok(!f.calls.some(x => x.args[0] === "pack"));
    assert.equal(JSON.parse(await readFile(join(f.input.outputDirectory, "preflight-evidence.json"))).status, "failed");
  }
});
test("only exact approved Go failure is accepted as FAIL, extra failure blocks", async () => {
  const Package = "github.com/Gentleman-Programming/engram/v3/internal/chunkcodec", Test = "TestCompressedEnvelopeRoundTripDoesNotExposePayloadText";
  const records = [{ Action: "output", Package, Test, Output: "compressed envelope exposed observation text\n" }, { Action: "fail", Package, Test }, { Action: "fail", Package }];
  const f = await fixture({ go: records.map(JSON.stringify).join("\n") });
  assert.equal((await runReleasePreflight(f.input)).receipts.find(x => x.name === "go").status, "accepted-baseline-failure");
  const bad = await fixture({ go: [...records, { Action: "fail", Package, Test: "Other" }].map(JSON.stringify).join("\n") });
  await assert.rejects(runReleasePreflight(bad.input), /go/); assert.ok(!bad.calls.some(x => x.command === "npm"));
});
test("pack traversal fails without reading or freezing an unowned artifact", async () => {
  const f = await fixture({ badPack: true }); await assert.rejects(runReleasePreflight(f.input), /npm pack/);
  const evidence = JSON.parse(await readFile(join(f.input.outputDirectory, "preflight-evidence.json")));
  assert.equal(evidence.status, "failed"); assert.equal(evidence.npmDigest, undefined);
});
test("unclean source, wrong tag and missing SDK block every release gate", async () => {
  for (const overrides of [{ dirty: true }, { badTag: true }, {}]) {
    const f = await fixture(overrides);
    if (!Object.keys(overrides).length) f.input.sdkRoot = join(f.input.sdkRoot, "missing");
    await assert.rejects(runReleasePreflight(f.input));
    assert.ok(f.calls.every(x => x.command === "git")); await assert.rejects(access(f.input.outputDirectory));
  }
});
test("existing output bytes survive rejection; Pi tags remain rejected on core route", async () => {
  const f = await fixture(); await mkdir(f.input.outputDirectory);
  await writeFile(join(f.input.outputDirectory, "sentinel"), "unchanged");
  await assert.rejects(runReleasePreflight(f.input), /exists/);
  assert.equal(await readFile(join(f.input.outputDirectory, "sentinel"), "utf8"), "unchanged");
  const pi = await fixture(); await assert.rejects(runReleasePreflight({ ...pi.input, releaseRef: "refs/tags/pi-v0.2.0" }), /Release ref/);
  assert.equal(pi.calls.length, 0);
});
test("CLI exact options and help; legacy Pi route is not a core request", () => {
  assert.equal(parsePreflightArgs(["--help"]).help, true);
  assert.throws(() => parsePreflightArgs(["--unknown"]), /options/);
  assert.throws(() => parsePreflightArgs(["--ref", "x", "--ref", "y"]), /options/);
  assert.deepEqual(parsePreflightArgs(["--ref", "refs/tags/v0.2.0", "--sdk-root", "/sdk", "--output", "/out"]), { releaseRef: "refs/tags/v0.2.0", sdkRoot: "/sdk", outputDirectory: "/out" });
});
