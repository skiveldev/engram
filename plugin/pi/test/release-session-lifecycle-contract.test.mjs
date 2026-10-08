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
const scratch = join(common, "gentle-checks/t2-parity/lifecycle-contract-owned");
mkdirSync(scratch, { recursive: true });

test("public session start/end effects retain independent MCP and Pi host contracts", async () => {
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
  const assertSessionEndOrder = (started, ended) => {
    // SQLite datetime('now') is UTC and has second precision.
    assert.match(ended, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const utcMillis = (value) => Date.parse(/^\d{4}-\d{2}-\d{2} /.test(value)
      ? `${value.replace(" ", "T")}Z` : value);
    assert.ok(Math.floor(utcMillis(ended) / 1000) >= Math.floor(utcMillis(started) / 1000));
  };
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
    const tools = new Map();
    const sandbox = await createPluginSandbox(mkdtempSync(join(scratch, "pi-")));
    (await importPluginFromSandbox(sandbox))({ registerTool: (tool) => tools.set(tool.name, tool), on() {}, appendEntry() {} });
    const ctx = { cwd: dir, sessionManager: { getSessionId: () => "pi-host" }, ui: { setStatus() {} } };
    const pi = (name, args) => tools.get(name).execute("paired", args, undefined, undefined, ctx);
    const mcp = async (name, args) => {
      const envelope = await http("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      assert.equal(envelope.error, undefined, JSON.stringify(envelope));
      return envelope.result;
    };
    const piSuccess = (result, data) => {
      assert.deepEqual(result.details, { data });
      assert.deepEqual(result, {
        content: [{ type: "text", text: JSON.stringify(result.details.data, null, 2) }], details: { data },
      });
    };
    const mcpSuccess = (result, data) => {
      const actual = JSON.parse(result.content[0].text);
      assert.deepEqual(actual, data);
      assert.deepEqual(result, { content: [{ type: "text", text: JSON.stringify(actual) }] });
    };
    const beforePreparation = await snapshot();
    piSuccess(await pi("mem_current_project", { cwd: dir }), {
      project: "other", project_source: "config", project_path: dir, cwd: dir, available_projects: null,
    });
    assert.deepEqual(ordered(await snapshot()), ordered(beforePreparation));

    for (const transport of ["HTTP", "MCP", "Pi"]) {
      const id = `independent-${transport.toLowerCase()}`;
      const before = await snapshot();
      if (transport === "HTTP") {
        assert.deepEqual(await http("/sessions", "POST", { id, project: "other", directory: dir }, 201), { id, status: "created" });
      } else if (transport === "MCP") {
        // MCP ignores caller project; explicit directory/config is authoritative.
        mcpSuccess(await mcp("mem_session_start", { id, project: "ignored", directory: dir }), {
          project: "other", project_source: "config", project_path: dir, result: `Session "${id}" started for project "other"`,
        });
      } else {
        piSuccess(await pi("mem_session_start", { id, project: "ignored", directory: dir }), { id, status: "created" });
      }
      const after = await snapshot();
      const actual = after.stored.sessions.find((row) => row.id === id);
      timestamp(actual.started_at);
      const row = { id, project: "other", ownership_mode: "shared", directory: dir, started_at: actual.started_at };
      assert.deepEqual(actual, row);
      const expected = structuredClone(before);
      expected.stored.sessions = [...(expected.stored.sessions ?? []), row];
      expected.stats.total_sessions++;
      assert.deepEqual(ordered(after), ordered(expected), "start changes only the complete session row and count");

      const beforeRepeat = await snapshot();
      if (transport === "HTTP") assert.deepEqual(await http("/sessions", "POST", { id, project: "other", directory: dir }, 201), { id, status: "created" });
      else if (transport === "MCP") mcpSuccess(await mcp("mem_session_start", { id, directory: dir }), {
        project: "other", project_source: "config", project_path: dir, result: `Session "${id}" started for project "other"`,
      });
      else piSuccess(await pi("mem_session_start", { id, directory: dir }), { id, status: "created" });
      assert.deepEqual(ordered(await snapshot()), ordered(beforeRepeat), "existing open-session registration is idempotent");

      const summary = `Completed ${transport}`;
      const beforeEnd = await snapshot();
      if (transport === "MCP") mcpSuccess(await mcp("mem_session_end", { id, summary, project: "ignored" }), {
        project: "parity", project_source: "process_override", project_path: "", result: `Session "${id}" completed`,
      });
      else assert.deepEqual(await http(`/sessions/${id}/end`, "POST", { summary }), { id, status: "completed" });
      const afterEnd = await snapshot();
      const ended = afterEnd.stored.sessions.find((entry) => entry.id === id);
      timestamp(ended.ended_at);
      assertSessionEndOrder(row.started_at, ended.ended_at);
      const expectedEnd = structuredClone(beforeEnd);
      Object.assign(expectedEnd.stored.sessions.find((entry) => entry.id === id), { ended_at: ended.ended_at, summary });
      assert.deepEqual(ordered(afterEnd), ordered(expectedEnd), "end changes only ended_at and summary, no counters");
    }

    for (const transport of ["HTTP", "MCP"]) {
      const before = await snapshot();
      const id = `absent-${transport.toLowerCase()}`;
      if (transport === "HTTP") assert.deepEqual(await http(`/sessions/${id}/end`, "POST", { summary: "No row" }), { id, status: "completed" });
      else mcpSuccess(await mcp("mem_session_end", { id, summary: "No row" }), {
        project: "parity", project_source: "process_override", project_path: "", result: `Session "${id}" completed`,
      });
      assert.deepEqual(ordered(await snapshot()), ordered(before), "no-row end succeeds without stored effects");
    }
    const beforeGuard = await snapshot();
    const guard = "Pi-native session end requires the current host session ID; end independent sessions directly outside Pi-native tools";
    assert.deepEqual(await pi("mem_session_end", { id: "independent-pi", summary: "Forbidden" }), {
      isError: true, content: [{ type: "text", text: guard }], details: { error: guard },
    });
    assert.deepEqual(ordered(await snapshot()), ordered(beforeGuard), "Pi foreign host-ID guard has no stored effects");

    // A rejected write establishes local Pi host ownership, separately from explicit start.
    const beforeHost = await snapshot();
    const error = "session_id and content are required";
    assert.deepEqual(await pi("mem_session_summary", { content: "" }), {
      isError: true, content: [{ type: "text", text: error }], details: { error, http_status: 400, data: { error } },
    });
    const afterHost = await snapshot();
    const host = afterHost.stored.sessions.find((entry) => entry.id === "pi-host");
    timestamp(host.started_at);
    assert.deepEqual(host, { id: "pi-host", project: "other", ownership_mode: "project_owned", directory: dir, started_at: host.started_at });
    const expectedHost = structuredClone(beforeHost);
    expectedHost.stored.sessions.push(host);
    expectedHost.stats.total_sessions++;
    assert.deepEqual(ordered(afterHost), ordered(expectedHost), "rejected write registers only the Pi-owned host row");
    const beforeHostEnd = await snapshot();
    piSuccess(await pi("mem_session_end", { id: "pi-host", summary: "Host completed" }), { id: "pi-host", status: "completed" });
    const afterHostEnd = await snapshot();
    const completedHost = afterHostEnd.stored.sessions.find((entry) => entry.id === "pi-host");
    timestamp(completedHost.ended_at);
    assertSessionEndOrder(host.started_at, completedHost.ended_at);
    const expectedHostEnd = structuredClone(beforeHostEnd);
    Object.assign(expectedHostEnd.stored.sessions.find((entry) => entry.id === "pi-host"), { ended_at: completedHost.ended_at, summary: "Host completed" });
    assert.deepEqual(ordered(afterHostEnd), ordered(expectedHostEnd), "Pi end applies only to its confirmed host row");
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_URL; else process.env.ENGRAM_URL = previous;
    if (url) await fetch(`${url}/stop`, { method: "POST" });
    assert.equal(await exited, 0, output);
  }
});
