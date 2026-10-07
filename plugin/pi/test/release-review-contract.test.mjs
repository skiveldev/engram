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

test("public review empty lists and fresh decision marking preserve unrelated global state", async () => {
  const dir = mkdtempSync(join(scratch, "review-"));
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
      const data = JSON.parse(text);
      assert.equal(text, `${JSON.stringify(data)}\n`);
      return data;
    };
    const mcp = async (name, args) => {
      const envelope = await http("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      assert.equal(envelope.error, undefined, JSON.stringify(envelope));
      return envelope.result;
    };
    // Publicly confirm the configured process project before relying on MCP mark's selector.
    const detected = await mcp("mem_current_project", {});
    assert.equal(detected.isError, undefined);
    const detection = JSON.parse(detected.content[0].text);
    assert.equal(detection.project, "parity");
    assert.equal(detection.source ?? detection.project_source, "process_override");
    for (const project of ["parity", "other"]) await http("/sessions", "POST", { id: `review-${project}`, project }, 201);
    const seeded = [];
    for (const transport of ["HTTP", "MCP", "Pi", "foreign"]) {
      const project = transport === "foreign" ? "other" : "parity";
      const title = `Review ${transport}`;
      const saved = await http("/observations", "POST", { session_id: `review-${project}`, project,
        type: "decision", scope: "project", title, content: title }, 201);
      assert.equal(saved.status, "saved");
      assert.ok(Number.isSafeInteger(saved.id) && saved.id > 0);
      seeded.push({ id: saved.id, title, project, transport });
    }
    const snapshot = async () => {
      const exported = await http("/export?all_projects=true");
      assert.ok(Number.isFinite(Date.parse(exported.exported_at)));
      assert.equal(exported.observations.length, seeded.length);
      for (const project of ["parity", "other"]) assert.ok(exported.sessions.some((entry) => entry.id === `review-${project}` && entry.project === project));
      for (const expected of seeded) assert.ok(exported.observations.some((entry) => entry.id === expected.id
        && entry.title === expected.title && entry.content === expected.title && entry.type === "decision"
        && entry.project === expected.project && entry.session_id === `review-${expected.project}`));
      const { exported_at, ...stored } = exported;
      return { stored, stats: await http("/stats?all_projects=true") };
    };
    const initial = await snapshot();
    for (const entry of initial.stored.observations) assert.ok(Date.parse(entry.review_after) > Date.now(), "publicly seeded decisions are not due");
    const tools = new Map();
    const sandbox = await createPluginSandbox(mkdtempSync(join(scratch, "review-pi-")));
    (await importPluginFromSandbox(sandbox))({ registerTool: (tool) => tools.set(tool.name, tool), on() {}, appendEntry() {} });
    const ctx = { cwd: dir, sessionManager: { getSessionId: () => "review-host" }, ui: { setStatus() {} } };
    const call = async (transport, args) => {
      if (transport === "HTTP") return args.action === "list" ? http("/review?project=parity")
        : http("/review/mark_reviewed?project=parity", "POST", { observation_id: args.observation_id });
      if (transport === "MCP") return mcp("mem_review", args);
      return tools.get("mem_review").execute("paired", args, undefined, undefined, ctx);
    };
    const success = (transport, result) => {
      if (transport === "HTTP") return result;
      assert.equal(result.isError, undefined);
      const data = transport === "Pi" ? result.details.data : JSON.parse(result.content[0].text);
      assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(data, null, transport === "Pi" ? 2 : undefined) }]);
      if (transport === "Pi") assert.deepEqual(result.details, { data });
      return data;
    };
    const emptyList = async (transport) => {
      const before = await snapshot();
      const data = success(transport, await call(transport, { action: "list", project: "parity" }));
      if (transport === "MCP") {
        assert.equal(typeof data.project_source, "string");
        assert.ok(data.project_source.length > 0);
        assert.deepEqual(data, { project: "parity", project_source: data.project_source, project_path: "",
          result: "No memories need review.", observations: [] });
      } else assert.deepEqual(data, { count: 0, observations: [] });
      assert.deepEqual(await snapshot(), before, "empty-list read preserves every global field/counter");
    };
    for (const transport of ["HTTP", "MCP", "Pi"]) {
      await emptyList(transport);
      const target = seeded.find((entry) => entry.transport === transport);
      const before = await snapshot();
      const old = before.stored.observations.find((entry) => entry.id === target.id);
      const data = success(transport, await call(transport, { action: "mark_reviewed", project: "parity", observation_id: target.id }));
      const after = await snapshot();
      const actual = after.stored.observations.find((entry) => entry.id === target.id);
      assert.ok(Number.isFinite(Date.parse(actual.review_after)) && Date.parse(actual.review_after) > Date.now());
      assert.ok(Number.isFinite(Date.parse(actual.updated_at)) && Date.parse(actual.updated_at) >= Date.parse(old.updated_at));
      const payload = { id: target.id, sync_id: old.sync_id, state: "active", review_after: actual.review_after };
      if (transport === "MCP") assert.deepEqual(data, { ...payload, project: "parity", project_source: "process_override", project_path: "",
        result: `Memory marked reviewed: #${target.id} "${target.title}" (decision)` });
      else assert.deepEqual(data, { ...payload, project: "parity", title: target.title, type: "decision" });
      const expected = structuredClone(before);
      expected.stored.observations = before.stored.observations.map((entry) => entry.id === target.id
        ? { ...entry, review_after: actual.review_after, updated_at: actual.updated_at } : entry);
      assert.deepEqual(after, expected, "only target review_after/updated_at may change; creation and all unrelated records/counters preserved");
      await emptyList(transport);
      const beforeReject = await snapshot();
      const missing = Math.max(...seeded.map((entry) => entry.id)) + 1000;
      if (transport === "HTTP") assert.deepEqual(await http("/review/mark_reviewed?project=parity", "POST", { observation_id: missing }, 404),
        { error: "observation not found in resolved project" });
      else {
        const error = transport === "MCP" ? "Failed to mark reviewed: observation not found in resolved project" : "observation not found in resolved project";
        const result = await call(transport, { action: "mark_reviewed", project: "parity", observation_id: missing });
        assert.equal(result.isError, true);
        assert.deepEqual(result.content, [{ type: "text", text: error }]);
        if (transport === "Pi") assert.deepEqual(result.details, { error, http_status: 404, data: { error } });
      }
      assert.deepEqual(await snapshot(), beforeReject, "missing-ID rejection preserves complete global stored data and counters");
    }
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_URL; else process.env.ENGRAM_URL = previous;
    if (url) await fetch(`${url}/stop`, { method: "POST" });
    assert.equal(await exited, 0, output);
  }
});
