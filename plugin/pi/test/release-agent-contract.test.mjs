import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createPluginSandbox, importPluginFromSandbox } from "./plugin-sandbox.mjs";

// Registered TypeBox stub evidence is not full TypeBox validation or semantic proof.
// MCP schemas below come from JSON-RPC tools/list, never source declarations.
const root = fileURLToPath(new URL("../../../", import.meta.url));
let listed;
const agent = [
  "mem_save", "mem_search", "mem_context", "mem_session_summary", "mem_session_start",
  "mem_session_end", "mem_get_observation", "mem_suggest_topic_key", "mem_capture_passive",
  "mem_save_prompt", "mem_update", "mem_current_project", "mem_list_projects", "mem_judge",
  "mem_compare", "mem_doctor", "mem_review", "mem_pin", "mem_unpin",
];
const extras = ["mem_delete", "mem_stats", "mem_timeline"];
const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
const scratch = join(common, "gentle-checks/t2-parity");
mkdirSync(scratch, { recursive: true });
const sandbox = await createPluginSandbox(mkdtempSync(join(scratch, "agent-")));
const register = await importPluginFromSandbox(sandbox);
const tools = new Map();
register({ registerTool: (tool) => { assert.ok(!tools.has(tool.name)); tools.set(tool.name, tool); }, on() {}, appendEntry() {} });

function mcpArguments(name) {
  assert.ok(listed?.has(name), `tools/list evidence missing: ${name}`);
  const schema = listed.get(name).inputSchema;
  assert.equal(schema.type, "object");
  return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => {
    const { description, ...constraints } = value;
    return [key, { ...constraints, required: (schema.required ?? []).includes(key) }];
  }));
}

const optionalString = { type: "string", required: false };
// Every variant asserts both sides exactly; no blanket exclusion or coercion.
const dispositions = {
  mem_save: { cwd: [undefined, optionalString], session_id: [optionalString, undefined], recovery_token: [optionalString, undefined], project_choice_reason: [optionalString, undefined] },
  mem_save_prompt: { cwd: [undefined, optionalString], session_id: [optionalString, undefined], recovery_token: [optionalString, undefined], project_choice_reason: [optionalString, undefined] },
  mem_session_summary: { cwd: [undefined, optionalString], session_id: [optionalString, undefined], recovery_token: [optionalString, undefined], project_choice_reason: [optionalString, undefined] },
  mem_capture_passive: { session_id: [optionalString, undefined] },
  mem_current_project: { cwd: [undefined, optionalString] },
  mem_context: { max_bytes: [{ type: "number", required: false }, { type: "integer", required: false, minimum: 1 }] },
  mem_get_observation: { project: [optionalString, undefined], history_cursor: [{ type: "number", required: false }, { type: "integer", required: false, minimum: 0 }] },
};
function piArguments(tool) {
  assert.equal(tool.parameters.kind, "Object");
  return Object.fromEntries(Object.entries(tool.parameters.args[0]).map(([name, schema]) => {
    const required = schema.kind !== "Optional";
    const inner = required ? schema : schema.args[0];
    const constraints = Object.fromEntries(Object.entries(inner.args[0] ?? {}).filter(([key]) => key !== "description"));
    return [name, { type: inner.kind.toLowerCase(), required, ...constraints }];
  }));
}

test("exact ProfileAgent set and Pi registrations allow only three named admin extras", () => {
  // The Go focused test independently exercises actual ProfileAgent tools/list.
  assert.equal(agent.length, 19);
  assert.deepEqual([...tools.keys()].sort(), [...agent, ...extras].sort());
});
test("paired public context max_bytes dispositions preserve stored counters", async () => {
  const dir = mkdtempSync(join(scratch, "protocol-"));
  const child = spawn("go", ["test", "./internal/mcp", "-run", "^TestPiAgentContractBridge$", "-count=1"], {
    cwd: root, env: { ...process.env, ENGRAM_PARITY_BRIDGE: dir }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  let url;
  const previous = process.env.ENGRAM_URL;
  try {
    for (let n = 0; n < 600 && !existsSync(join(dir, "url")); n++) {
      assert.equal(child.exitCode, null, output);
      await delay(100);
    }
    assert.ok(existsSync(join(dir, "url")), `protocol bridge unavailable: ${output}`);
    url = readFileSync(join(dir, "url"), "utf8");
    process.env.ENGRAM_URL = url;
    const registered = new Map();
    const fixture = await createPluginSandbox(mkdtempSync(join(scratch, "paired-")));
    (await importPluginFromSandbox(fixture))({ registerTool: (tool) => registered.set(tool.name, tool), on() {}, appendEntry() {} });
    const ctx = { cwd: dir, sessionManager: { getSessionId: () => "parity-host" }, ui: { setStatus() {} } };
    const rpc = async (name, args) => {
      const response = await fetch(`${url}/mcp`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      assert.equal(response.status, 200);
      const envelope = await response.json();
      assert.equal(envelope.error, undefined, JSON.stringify(envelope));
      return envelope.result;
    };
    const inventory = await fetch(`${url}/mcp`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) });
    const listing = await inventory.json();
    assert.equal(listing.error, undefined, JSON.stringify(listing));
    listed = new Map(listing.result.tools.map((tool) => [tool.name, tool]));
    assert.equal(listing.result.tools.length, 19);
    assert.deepEqual([...listed.keys()].sort(), [...agent].sort());
    const seeded = await fetch(`${url}/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "parity-seed", project: "parity" }) });
    assert.equal(seeded.status, 201, await seeded.text());
    const marker = "paired-context-observation-marker";
    const observation = await fetch(`${url}/observations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: "parity-seed", project: "parity", type: "note", title: marker, content: marker }) });
    assert.equal(observation.status, 201, await observation.text());
    const stats = async () => (await fetch(`${url}/stats?all_projects=true`)).json();
    const before = await stats();
    const baseline = await rpc("mem_context", { project: "parity" });
    for (const value of [1, 1.5, 0, -1, 1000000000]) {
      const mcp = await rpc("mem_context", { project: "parity", max_bytes: value });
      assert.notEqual(mcp.isError, true, JSON.stringify(mcp));
      if (value === 1.5 || value <= 0) assert.deepEqual(mcp, baseline, "MCP compatibility fallback");
      // Direct stub-registered execute bypasses Pi's host validator. Only valid
      // inputs are paired here; rejection belongs to pi-host-validation.mjs.
      if (Number.isInteger(value) && value > 0) {
        const pi = await registered.get("mem_context").execute("paired", { project: "parity", max_bytes: value }, undefined, undefined, ctx);
        assert.notEqual(pi.isError, true, JSON.stringify(pi));
        const mcpEnvelope = JSON.parse(mcp.content[0].text);
        assert.equal(mcpEnvelope.project, "parity");
        assert.equal(typeof mcpEnvelope.project_source, "string");
        assert.ok(Object.hasOwn(mcpEnvelope, "project_path"));
        assert.equal(typeof mcpEnvelope.result, "string");
        assert.equal(typeof pi.details.data.context, "string");
        assert.equal(pi.content[0].text, pi.details.data.context, "Pi renders the HTTP context field");
        assert.ok(mcpEnvelope.result.startsWith(pi.details.data.context), "MCP preserves shared context before its stats/nudge suffix");
        if (value > marker.length) {
          assert.ok(pi.details.data.context.includes(marker), "HTTP/Pi returns seeded observation");
          assert.ok(mcpEnvelope.result.includes(marker), "MCP returns seeded observation");
        }
      }
      assert.deepEqual(await stats(), before, "read/rejected input must not mutate stored counters");
    }
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_URL; else process.env.ENGRAM_URL = previous;
    if (url) await fetch(`${url}/stop`, { method: "POST" });
    assert.equal(await exited, 0, output);
  }
});

for (const name of agent) {
  test(`public argument contract: ${name}`, () => {
    assert.ok(tools.has(name), `${name} must be registered`);
    const pi = piArguments(tools.get(name));
    const mcp = mcpArguments(name);
    for (const [field, [mcpShape, piShape]] of Object.entries(dispositions[name] ?? {})) {
      assert.deepEqual(mcp[field], mcpShape, `${name}.${field}: MCP disposition`);
      assert.deepEqual(pi[field], piShape, `${name}.${field}: Pi disposition`);
      delete mcp[field];
      delete pi[field];
    }
    assert.deepEqual(pi, mcp, `${name}: unresolved public contract difference (not a host waiver)`);
  });
}
