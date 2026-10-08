import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createPluginSandbox, importPluginFromSandbox } from "./plugin-sandbox.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
const scratch = join(common, "gentle-checks/t2-parity/summary-contract-owned");
mkdirSync(scratch, { recursive: true });

test("session summaries preserve complete public effects and explicit title variants", async () => {
  const dir = mkdtempSync(join(scratch, "bridge-"));
  mkdirSync(join(dir, ".engram"));
  writeFileSync(join(dir, ".engram/config.json"), '{"project_name":"other"}');
  const child = spawn("go", ["test", "./internal/mcp", "-run", "^TestPiAgentContractBridge$", "-count=1"], {
    cwd: root, env: { ...process.env, ENGRAM_PARITY_BRIDGE: dir }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  const previous = process.env.ENGRAM_URL;
  let url;
  const timestamp = (value) => { assert.equal(typeof value, "string"); assert.ok(Number.isFinite(Date.parse(value)), value); };
  const ordered = (state) => ({ ...state, stored: { ...state.stored,
    sessions: [...(state.stored.sessions ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    observations: [...state.stored.observations].sort((a, b) => a.id - b.id),
    prompts: [...(state.stored.prompts ?? [])].sort((a, b) => a.id - b.id),
    ...(state.stored.relations ? { relations: [...state.stored.relations].sort((a, b) => a.sync_id.localeCompare(b.sync_id)) } : {}),
  } });
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
    const snapshot = async () => {
      const exported = await http("/export?all_projects=true");
      timestamp(exported.exported_at);
      const { exported_at, ...stored } = exported;
      return { stored, stats: await http("/stats?all_projects=true") };
    };
    for (const project of ["parity", "other"]) {
      const before = await snapshot();
      const id = `save-${project}`;
      assert.deepEqual(await http("/sessions", "POST", { id, project, directory: dir }, 201), { id, status: "created" });
      const after = await snapshot();
      const actual = after.stored.sessions.find((entry) => entry.id === id);
      timestamp(actual.started_at);
      const row = { id, project, ownership_mode: "shared", directory: dir, started_at: actual.started_at };
      assert.deepEqual(actual, row);
      const expected = structuredClone(before);
      expected.stored.sessions = [...(before.stored.sessions ?? []), row];
      expected.stats.total_sessions++;
      assert.deepEqual(ordered(after), ordered(expected), "separate public session seed effect");
    }
    const tools = new Map();
    const sandbox = await createPluginSandbox(mkdtempSync(join(scratch, "pi-")));
    (await importPluginFromSandbox(sandbox))({ registerTool: (tool) => tools.set(tool.name, tool), on() {}, appendEntry() {} });
    const ctx = { cwd: dir, sessionManager: { getSessionId: () => "save-parity" }, ui: { setStatus() {} } };
    const beforePreparation = await snapshot();
    const preparation = await tools.get("mem_current_project").execute("prepare", { cwd: ctx.cwd }, undefined, undefined, ctx);
    assert.equal(preparation.isError, undefined, JSON.stringify(preparation));
    const resolved = { project: "other", project_source: "config", project_path: dir, cwd: dir, available_projects: null };
    assert.deepEqual(preparation.details, { data: resolved });
    assert.deepEqual(preparation.content, [{ type: "text", text: JSON.stringify(preparation.details.data, null, 2) }]);
    assert.deepEqual(ordered(await snapshot()), ordered(beforePreparation), "public config preparation is immutable");
    const target = "parity";
    assert.notEqual(target, resolved.project);
    const satelliteID = `${ctx.sessionManager.getSessionId()}@${target}`;
    const call = async (transport, title, content, rejected = false) => {
      const args = { title, content, project: target, session_id: "save-parity" };
      if (transport === "HTTP") return http("/observations", "POST", { ...args, type: "session_summary" }, rejected ? 400 : 201);
      if (transport === "Pi") return tools.get("mem_session_summary").execute("paired", { content, project: target }, undefined, undefined, ctx);
      const envelope = await http("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "mem_session_summary", arguments: { content, session_id: "save-parity" } } });
      assert.equal(envelope.error, undefined, JSON.stringify(envelope));
      return envelope.result;
    };
    const beforeFirstReject = await snapshot();
    const firstReject = await call("Pi", "Session summary", "", true);
    const firstError = "session_id and content are required";
    assert.deepEqual(firstReject, { isError: true, content: [{ type: "text", text: firstError }],
      details: { error: firstError, http_status: 400, data: { error: firstError } } });
    const afterFirstReject = await snapshot();
    const satellite = afterFirstReject.stored.sessions.find((entry) => entry.id === satelliteID);
    timestamp(satellite.started_at);
    const sessionRow = { id: satelliteID, project: target, ownership_mode: "project_owned", directory: "", started_at: satellite.started_at };
    assert.deepEqual(satellite, sessionRow);
    const expectedFirstReject = structuredClone(beforeFirstReject);
    expectedFirstReject.stored.sessions.push(sessionRow);
    expectedFirstReject.stats.total_sessions++;
    assert.deepEqual(ordered(afterFirstReject), ordered(expectedFirstReject), "first rejected Pi summary registers only its effective satellite");
    // Disjoint ASCII fixtures: no family keywords, candidate overlap, private tags or truncation.
    const fixtures = [
      ["HTTP", "Session summary", "Quartz"], ["MCP", "Session summary: parity", "Zephyr"], ["Pi", "Session summary", "Violet"],
    ];
    for (const [transport, title, content] of fixtures) {
      const before = await snapshot();
      const result = await call(transport, title, content);
      const after = await snapshot();
      const additions = after.stored.observations.filter((entry) => !before.stored.observations.some((old) => old.id === entry.id));
      assert.equal(additions.length, 1);
      const actual = additions[0];
      assert.ok(Number.isSafeInteger(actual.id) && actual.id > 0);
      assert.equal(typeof actual.sync_id, "string");
      assert.ok(actual.sync_id.startsWith("obs-") && !before.stored.observations.some((entry) => entry.sync_id === actual.sync_id));
      for (const key of ["created_at", "updated_at", "last_seen_at"]) timestamp(actual[key]);
      assert.ok(Date.parse(actual.updated_at) >= Date.parse(actual.created_at));
      assert.ok(Date.parse(actual.last_seen_at) >= Date.parse(actual.created_at));
      const row = { id: actual.id, sync_id: actual.sync_id, session_id: transport === "Pi" ? satelliteID : "save-parity",
        type: "session_summary", title, content, project: target, scope: "project", revision_count: 1, duplicate_count: 1,
        last_seen_at: actual.last_seen_at, created_at: actual.created_at, updated_at: actual.updated_at, pinned: false };
      assert.deepEqual(actual, row, "complete input-derived exported observation, including metadata defaults");
      const data = transport === "HTTP" ? result : transport === "Pi" ? result.details.data : JSON.parse(result.content[0].text);
      if (transport === "MCP") {
        assert.deepEqual(data, { project: target, project_source: "session", project_path: dir,
          result: `Session summary saved for project "${target}"`,
          id: row.id, sync_id: row.sync_id, state: "active", judgment_required: false });
      } else assert.deepEqual(data, { id: row.id, status: "saved" });
      if (transport !== "HTTP") {
        assert.equal(result.isError, undefined);
        assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(data, null, transport === "Pi" ? 2 : undefined) }]);
        if (transport === "Pi") assert.deepEqual(result.details, { data });
      }
      const expected = structuredClone(before);
      expected.stored.observations.push(row);
      expected.stats.total_observations++;
      expected.stats.projects = [target];
      assert.deepEqual(ordered(after), ordered(expected), "only complete save row/count changes after satellite registration");
      const beforeDuplicate = await snapshot();
      const duplicate = await call(transport, title, content);
      assert.deepEqual(duplicate, result, "duplicate retains complete response and observation identity");
      const afterDuplicate = await snapshot();
      const duplicateRow = afterDuplicate.stored.observations.find((entry) => entry.id === row.id);
      for (const key of ["updated_at", "last_seen_at"]) {
        timestamp(duplicateRow[key]);
        assert.ok(Date.parse(duplicateRow[key]) >= Date.parse(row[key]));
      }
      const expectedDuplicate = structuredClone(beforeDuplicate);
      const expectedRow = expectedDuplicate.stored.observations.find((entry) => entry.id === row.id);
      expectedRow.duplicate_count++;
      expectedRow.updated_at = duplicateRow.updated_at;
      expectedRow.last_seen_at = duplicateRow.last_seen_at;
      assert.deepEqual(ordered(afterDuplicate), ordered(expectedDuplicate), "duplicate changes only its count and validated timestamps, not rows or stats");
      for (const badContent of ["", " \t\n "]) {
        const badTitle = title;
        const beforeReject = await snapshot();
        const rejected = await call(transport, badTitle, badContent, true);
        const error = transport === "MCP" ? "content is required for mem_session_summary"
          : badContent === "" ? "session_id and content are required" : "observation content is required";
        if (transport === "HTTP") assert.deepEqual(rejected, { error });
        else {
          assert.equal(rejected.isError, true);
          assert.deepEqual(rejected.content, [{ type: "text", text: error }]);
          if (transport === "Pi") assert.deepEqual(rejected.details, { error, http_status: 400, data: { error } });
        }
        assert.deepEqual(ordered(await snapshot()), ordered(beforeReject), "rejected save preserves full global export and all counters after established session");
      }
    }
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_URL; else process.env.ENGRAM_URL = previous;
    if (url) await fetch(`${url}/stop`, { method: "POST" });
    assert.equal(await exited, 0, output);
  }
});
