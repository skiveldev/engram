import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createPluginSandbox, importPluginFromSandbox } from "./plugin-sandbox.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
const scratch = join(common, "gentle-checks/t2-parity");
mkdirSync(scratch, { recursive: true });

// Pi's accepted local slug variant is not equivalent to the core suggestion.
test("topic-key core contracts and the explicit Pi variant preserve global stored state", async () => {
  const dir = mkdtempSync(join(scratch, "topic-key-"));
  const child = spawn("go", ["test", "./internal/mcp", "-run", "^TestPiAgentContractBridge$", "-count=1"], {
    cwd: root, env: { ...process.env, ENGRAM_PARITY_BRIDGE: dir }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  const previous = process.env.ENGRAM_URL;
  let url;
  try {
    for (let n = 0; n < 600 && !existsSync(join(dir, "url")); n++) {
      assert.equal(child.exitCode, null, output);
      await delay(100);
    }
    assert.ok(existsSync(join(dir, "url")), `bridge unavailable: ${output}`);
    url = readFileSync(join(dir, "url"), "utf8");
    process.env.ENGRAM_URL = url;
    const http = async (path, method = "GET", body, status = 200) => {
      const response = await fetch(`${url}${path}`, { method, headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      assert.equal(response.status, status, text);
      assert.equal(response.headers.get("content-type"), "application/json");
      return JSON.parse(text);
    };
    await http("/sessions", "POST", { id: "topic-key-seed", project: "parity" }, 201);
    const marker = "topic-key-state-marker";
    const saved = await http("/observations", "POST", { session_id: "topic-key-seed", project: "parity",
      type: "note", title: marker, content: marker, scope: "project" }, 201);
    assert.equal(saved.status, "saved");
    assert.ok(Number.isSafeInteger(saved.id) && saved.id > 0);
    const snapshot = async () => {
      const exported = await http("/export?all_projects=true");
      assert.equal(typeof exported.exported_at, "string");
      assert.ok(Number.isFinite(Date.parse(exported.exported_at)));
      assert.ok(exported.sessions.some((entry) => entry.id === "topic-key-seed" && entry.project === "parity"));
      assert.ok(exported.observations.some((entry) => entry.id === saved.id && entry.project === "parity"
        && entry.session_id === "topic-key-seed" && entry.title === marker && entry.content === marker));
      const { exported_at, ...stored } = exported;
      return { stored, stats: await http("/stats?all_projects=true") };
    };
    const read = async (label, operation) => {
      const before = await snapshot();
      try { return await operation(); }
      finally { assert.deepEqual(await snapshot(), before, `${label}: every exported stored field and counter unchanged`); }
    };
    const tools = new Map();
    const sandbox = await createPluginSandbox(mkdtempSync(join(scratch, "topic-key-pi-")));
    (await importPluginFromSandbox(sandbox))({ registerTool: (tool) => tools.set(tool.name, tool), on() {}, appendEntry() {} });
    const ctx = { cwd: dir, sessionManager: { getSessionId: () => "topic-key-host" }, ui: { setStatus() {} } };
    const rpc = (args) => read("MCP suggestion", async () => {
      const envelope = await http("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "mem_suggest_topic_key", arguments: args } });
      assert.equal(envelope.error, undefined, JSON.stringify(envelope));
      return envelope.result;
    });
    const pi = (args) => read("Pi local suggestion", () => tools.get("mem_suggest_topic_key").execute("paired", args, undefined, undefined, ctx));
    const cases = [
      [{ type: "Architecture", title: "  Auth Model  ", content: "ignored" }, "architecture/auth-model", "auth-model"],
      [{ type: "bugfix", content: "Fix nil panic in auth middleware on empty token" },
        "bug/fix-nil-panic-in-auth-middleware-on-empty", "fix-nil-panic-in-auth-middleware-on-empty-token"],
      [{ title: "!!!", content: "???" }, "topic/general", "memory"],
    ];
    for (const [args, coreKey, piKey] of cases) {
      assert.deepEqual(await read("HTTP suggestion", () => http("/topic-keys/suggest", "POST", args)), { topic_key: coreKey });
      const mcp = await rpc(args);
      assert.notEqual(mcp.isError, true);
      assert.deepEqual(mcp.content, [{ type: "text", text: `Suggested topic_key: ${coreKey}` }]);
      const local = await pi(args);
      assert.notEqual(local.isError, true);
      assert.deepEqual(local.details.data, { topic_key: piKey });
      assert.deepEqual(local.content, [{ type: "text", text: JSON.stringify({ topic_key: piKey }, null, 2) }]);
    }
    const error = "provide title or content to suggest a topic_key";
    for (const args of [{}, { title: "", content: "" }, { title: "  ", content: "\n\t" }]) {
      await read("rejected HTTP suggestion", async () => {
        const response = await fetch(`${url}/topic-keys/suggest`, { method: "POST",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) });
        assert.equal(response.status, 400);
        assert.equal(response.headers.get("content-type"), "application/json");
        assert.equal(await response.text(), `${JSON.stringify({ error })}\n`);
      });
      const mcp = await rpc(args);
      assert.equal(mcp.isError, true);
      assert.deepEqual(mcp.content, [{ type: "text", text: error }]);
      const local = await pi(args);
      assert.notEqual(local.isError, true);
      assert.deepEqual(local.details.data, { topic_key: "memory" });
      assert.deepEqual(local.content, [{ type: "text", text: JSON.stringify({ topic_key: "memory" }, null, 2) }]);
    }
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_URL; else process.env.ENGRAM_URL = previous;
    if (url) await fetch(`${url}/stop`, { method: "POST" });
    assert.equal(await exited, 0, output);
  }
});
