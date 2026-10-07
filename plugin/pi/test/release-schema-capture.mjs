// Explicit real-dependency capture entrypoint; never part of the default test glob.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { capturePiSchema } from "../release/schema-capture.mjs";
import { PROFILE_AGENT, PI_EXTRAS } from "../release/canonical-contract.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const sdkRoot = process.env.ENGRAM_PI_SDK_ROOT;
assert.ok(sdkRoot, "ENGRAM_PI_SDK_ROOT is required; no downloads or skips");
const require = createRequire(join(sdkRoot, "package.json"));
const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
const owned = join(common, "gentle-checks/t3-capture");
await mkdir(owned, { recursive: true });
const dir = await mkdtemp(join(owned, "capture-"));
const keep = new Set(["PATH", "GOROOT", "GOMODCACHE", "GOPROXY", "GOSUMDB", "GOTOOLCHAIN", "GOFLAGS"]);
for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
for (const name of ["home", "tmp", "go-cache", "node-cache"]) await mkdir(join(dir, name));
Object.assign(process.env, { HOME: join(dir, "home"), TMPDIR: join(dir, "tmp"), GOTMPDIR: join(dir, "tmp"),
  GOCACHE: join(dir, "go-cache"), NODE_COMPILE_CACHE: join(dir, "node-cache"), NO_UPDATE_NOTIFIER: "1",
  GOPROXY: "off", GOSUMDB: "off", GOTOOLCHAIN: "local", GOFLAGS: "-mod=readonly" });

// Load the actual plugin with actual installed dependencies, not the TypeBox/TUI stubs.
const fixture = join(dir, "plugin");
await mkdir(join(fixture, "node_modules/@earendil-works"), { recursive: true });
for (const name of ["index.ts", "compaction-recovery.js", "memory-tool-chrome.js", "private-redaction.js"]) {
  await copyFile(join(root, "plugin/pi", name), join(fixture, name));
}
const dependencyRoots = {};
for (const name of ["typebox", "@earendil-works/pi-tui"]) {
  const entry = await realpath(require.resolve(name));
  let packageRoot = dirname(entry);
  // Follow only the resolved package's exact parent chain, never scan directories.
  for (let n = 0; n < 4; n++) {
    try {
      const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
      if (metadata.name === name) { dependencyRoots[name] = { root: packageRoot, version: metadata.version }; break; }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    packageRoot = dirname(packageRoot);
  }
  assert.ok(dependencyRoots[name], `resolved dependency package missing: ${name}`);
  await symlink(dependencyRoots[name].root, join(fixture, "node_modules", name), "dir");
}
const tools = new Map();
const register = (await import(pathToFileURL(join(fixture, "index.ts")).href)).default;
register({ registerTool(tool) {
  assert.ok(!tools.has(tool.name), "duplicate registration");
  tools.set(tool.name, { name: tool.name, description: tool.description, label: tool.label, ...capturePiSchema(tool.parameters) });
}, on() {}, appendEntry() {} });

test("real TypeBox registration and MCP tools/list capture preserves schema metadata", { timeout: 120000 }, async () => {
  assert.deepEqual([...tools.keys()].sort(), [...PROFILE_AGENT, ...PI_EXTRAS].sort());
  assert.ok([...tools.values()].some(tool => tool.schemaMetadata.length > 0));
  const child = spawn("go", ["test", "./internal/mcp", "-run", "^TestPiAgentContractBridge$", "-count=1", "-timeout=110s"], {
    cwd: root, env: { ...process.env, ENGRAM_PARITY_BRIDGE: dir }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  let url;
  try {
    for (let n = 0; n < 600; n++) {
      assert.equal(child.exitCode, null, output);
      try { url = await readFile(join(dir, "url"), "utf8"); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await delay(100);
    }
    assert.ok(url, `MCP bridge unavailable: ${output}`);
    assert.equal(new URL(url).hostname, "127.0.0.1");
    const snapshot = async () => {
      const stats = await (await fetch(`${url}/stats?all_projects=true`)).json();
      const { exported_at, ...data } = await (await fetch(`${url}/export`)).json();
      assert.ok(Number.isFinite(Date.parse(exported_at)));
      return { stats, data };
    };
    const before = await snapshot();
    const response = await fetch(`${url}/mcp`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    assert.equal(response.status, 200);
    const envelope = await response.json(); assert.equal(envelope.error, undefined);
    const mcp = envelope.result.tools;
    assert.deepEqual(mcp.map(tool => tool.name).sort(), [...PROFILE_AGENT].sort());
    assert.deepEqual(await snapshot(), before, "listing changes no public stored fields/counters");
    // Raw capture only: dispositions and candidate binding are separate gates.
    await writeFile(join(dir, "schema-capture.json"), JSON.stringify({ schema: "engram.schema-capture/v1", dependencies: dependencyRoots, mcp, pi: [...tools.values()] }, null, 2) + "\n");
    console.log(`capture retained: ${dir}`);
  } finally {
    if (url) await fetch(`${url}/stop`, { method: "POST" }); else child.kill("SIGTERM");
    assert.equal(await exited, 0, output);
    await writeFile(join(dir, "bridge.log"), output);
  }
});
