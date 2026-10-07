import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createPluginSandbox, importPluginFromSandbox } from "./plugin-sandbox.mjs";

// Public core effects, not SDK validation or simulated observation responses.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
const scratch = join(common, "gentle-checks/t2-parity");
mkdirSync(scratch, { recursive: true });

test("paired observation defaults, chronological pagination and MCP-only response context preserve public state", async () => {
  const dir = mkdtempSync(join(scratch, "observation-"));
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
      return JSON.parse(text);
    };
    const snapshot = async () => {
      const exported = await http("/export?all_projects=true");
      assert.ok(Array.isArray(exported.sessions));
      assert.ok(Array.isArray(exported.observations));
      for (const project of ["parity", "other-context"]) {
        assert.ok(exported.sessions.some((entry) => entry.id === `seed-${project}` && entry.project === project));
      }
      assert.ok(exported.observations.some((entry) => entry.id === id && entry.project === "parity"
        && entry.session_id === "seed-parity" && entry.title === title && entry.content === content(52)
        && entry.revision_count === 53));
      assert.equal(typeof exported.exported_at, "string");
      assert.ok(Number.isFinite(Date.parse(exported.exported_at)), "valid export generation timestamp");
      const { exported_at, ...stored } = exported;
      return { stored, stats: await http("/stats?all_projects=true") };
    };
    const read = async (label, operation) => {
      const before = await snapshot();
      try { return await operation(); }
      finally { assert.deepEqual(await snapshot(), before, `${label}: all exported stored fields and counters unchanged`); }
    };
    for (const project of ["parity", "other-context"]) {
      await http("/sessions", "POST", { id: `seed-${project}`, project }, 201);
    }
    const title = "Public observation pagination";
    const content = (n) => `observation-state-${String(n).padStart(2, "0")}\n${"full-content-".repeat(30)}END-${n}`;
    const created = await http("/observations", "POST", {
      session_id: "seed-parity", project: "parity", type: "note", scope: "project", title, content: content(0),
    }, 201);
    assert.equal(created.status, "saved");
    const id = created.id;
    assert.ok(Number.isSafeInteger(id) && id > 0, "identity comes from public POST");
    for (let n = 1; n <= 52; n++) {
      const updated = await http(`/observations/${id}?expected_project=parity`, "PATCH", { content: content(n) });
      assert.equal(updated.id, id);
      assert.equal(updated.content, content(n));
    }
    const tools = new Map();
    const sandbox = await createPluginSandbox(mkdtempSync(join(scratch, "observation-pi-")));
    (await importPluginFromSandbox(sandbox))({ registerTool: (tool) => tools.set(tool.name, tool), on() {}, appendEntry() {} });
    const tool = tools.get("mem_get_observation");
    assert.equal(tool.parameters.args[0].project, undefined, "Pi has no MCP response-context argument");
    const ctx = { cwd: dir, sessionManager: { getSessionId: () => "observation-host" }, ui: { setStatus() {} } };
    const rpc = async (args) => {
      const envelope = await http("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "mem_get_observation", arguments: { id, ...args } } });
      assert.equal(envelope.error, undefined, JSON.stringify(envelope));
      return envelope.result;
    };
    const historyKeys = ["history", "version_count", "history_truncated", "history_from_version", "history_cursor"];
    const paired = async (args, versions, continuation = false) => {
      const query = new URLSearchParams(Object.entries(args).map(([key, value]) => [key, String(value)]));
      const data = await read("HTTP observation", () => http(`/observations/${id}?${query}`));
      assert.equal(data.id, id);
      assert.equal(data.project, "parity");
      assert.equal(data.title, title);
      assert.equal(data.content, content(52));
      const pi = await read("registered Pi observation", () => tool.execute("paired", { id, ...args }, undefined, undefined, ctx));
      assert.notEqual(pi.isError, true, JSON.stringify(pi));
      assert.deepEqual(pi.details.data, data, "complete HTTP JSON, without dropping unknown fields");
      const rendered = pi.content[0].text;
      assert.equal(pi.content[0].type, "text");
      // Pi preserves its own formatter; MCP is a JSON envelope containing prose.
      assert.ok(rendered.includes(content(52)) || rendered.includes(JSON.stringify(content(52)).slice(1, -1)), "Pi renders full current content");
      const mcp = await read("MCP observation", () => rpc(args));
      assert.notEqual(mcp.isError, true, JSON.stringify(mcp));
      assert.equal(mcp.content.length, 1);
      assert.equal(mcp.content[0].type, "text");
      const envelope = JSON.parse(mcp.content[0].text);
      assert.equal(envelope.project, "parity");
      assert.equal(typeof envelope.project_source, "string");
      assert.ok(Object.hasOwn(envelope, "project_path"));
      assert.equal(typeof envelope.result, "string");
      assert.ok(envelope.result.includes(content(52)), "MCP renders full current content");
      assert.ok(envelope.result.includes(String(id)), "MCP renders actual observation identity");
      for (const key of historyKeys) {
        assert.equal(Object.hasOwn(envelope, key), Object.hasOwn(data, key), `${key} presence`);
        assert.deepEqual(envelope[key], data[key], `${key} complete shared value`);
      }
      if (versions === undefined) {
        for (const key of historyKeys) assert.equal(Object.hasOwn(data, key), false, `${key} hidden`);
        assert.ok(!envelope.result.includes("History"));
        assert.ok(!rendered.includes(content(0)));
      } else {
        assert.equal(data.version_count, 52);
        assert.equal(data.history.length, versions.length);
        for (let i = 0; i < versions.length; i++) {
          const entry = data.history[i];
          const version = versions[i];
          assert.equal(entry.version, version);
          assert.equal(entry.title, title);
          assert.equal(entry.content, content(version - 1));
          assert.equal(typeof entry.created_at, "string");
          assert.ok(entry.created_at.length > 0);
          assert.ok(envelope.result.includes(`Version ${version}`));
          assert.ok(envelope.result.includes(entry.content));
          assert.ok(rendered.includes(entry.content) || rendered.includes(JSON.stringify(entry.content).slice(1, -1)));
        }
        if (continuation) {
          assert.equal(data.history_truncated, true);
          assert.equal(data.history_from_version, 3);
          assert.equal(data.history_cursor, 3);
          assert.ok(envelope.result.includes("History (50 of 52 previous versions — older versions omitted):"));
        } else {
          for (const key of historyKeys.slice(2)) assert.equal(Object.hasOwn(data, key), false, `${key} absent at end`);
        }
      }
      return { data, envelope };
    };
    const baseline = await paired({}, undefined);
    await paired({ include_history: false }, undefined);
    await paired({ include_history: false, history_cursor: -1 }, undefined); // Not SDK rejection evidence.
    const first = await paired({ include_history: true, history_cursor: 0 }, Array.from({ length: 50 }, (_, i) => i + 3), true);
    await paired({ include_history: true, history_cursor: first.data.history_cursor }, [1, 2]);
    await paired({ include_history: true, history_cursor: 1 }, []);
    const contextual = await read("MCP-only alternate response context", () => rpc({ project: "other-context" }));
    assert.notEqual(contextual.isError, true, JSON.stringify(contextual));
    const contextEnvelope = JSON.parse(contextual.content[0].text);
    assert.equal(contextEnvelope.project, "other-context");
    assert.equal(typeof contextEnvelope.project_source, "string");
    assert.ok(Object.hasOwn(contextEnvelope, "project_path"));
    assert.equal(contextEnvelope.result, baseline.envelope.result, "context is not ID ownership filtering");
    for (const key of historyKeys) assert.equal(Object.hasOwn(contextEnvelope, key), false);

    // Direct registered execution observes HTTP forwarding, not SDK validation.
    const missingId = id + 1000000;
    const cursorError = "history_cursor must be a non-negative integer";
    const rejected = [
      { args: { id: missingId }, status: 404, message: "observation not found", mcpMessage: `Observation #${missingId} not found` },
      { args: { id: missingId, include_history: true, history_cursor: -1 }, status: 404, message: "observation not found", mcpMessage: `Observation #${missingId} not found` },
      ...[-1, 1.5, "not-a-number"].map((history_cursor) => ({
        args: { id, include_history: true, history_cursor }, status: 400, message: cursorError, mcpMessage: cursorError,
      })),
    ];
    for (const { args, status, message, mcpMessage } of rejected) {
      const query = new URLSearchParams(Object.entries(args).filter(([key]) => key !== "id").map(([key, value]) => [key, String(value)]));
      await read("rejected HTTP observation", async () => {
        const response = await fetch(`${url}/observations/${args.id}?${query}`);
        assert.equal(response.status, status);
        assert.equal(response.headers.get("content-type"), "application/json");
        assert.equal(await response.text(), `${JSON.stringify({ error: message })}\n`);
      });
      await read("rejected registered Pi observation", async () => {
        const result = await tool.execute("rejected", args, undefined, undefined, ctx);
        assert.equal(result.isError, true);
        assert.deepEqual(result.content, [{ type: "text", text: message }]);
        assert.deepEqual(result.details, { error: message, http_status: status, data: { error: message } });
      });
      await read("rejected MCP observation", async () => {
        const result = await rpc(args);
        assert.equal(result.isError, true);
        assert.deepEqual(result.content, [{ type: "text", text: mcpMessage }]);
      });
    }
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_URL; else process.env.ENGRAM_URL = previous;
    if (url) await fetch(`${url}/stop`, { method: "POST" });
    assert.equal(await exited, 0, output);
  }
});
