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
const scratch = join(common, "gentle-checks/t2-parity");
mkdirSync(scratch, { recursive: true });

test("public prompt saves have exact rows, transport envelopes and global effects", async () => {
  const dir = mkdtempSync(join(scratch, "save-prompt-"));
  // Explicit owned project lock precedes Git/history detection and Pi initialization.
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
    const rawSnapshot = async () => {
      const exported = await http("/export?all_projects=true");
      assert.ok(Number.isFinite(Date.parse(exported.exported_at)));
      const { exported_at, ...stored } = exported;
      return { stored, stats: await http("/stats?all_projects=true") };
    };
    const seeded = [];
    for (const project of ["parity", "other"]) {
      const before = await rawSnapshot();
      const id = `prompt-${project}`;
      assert.deepEqual(await http("/sessions", "POST", { id, project, directory: dir }, 201), { id, status: "created" });
      const after = await rawSnapshot();
      const actual = after.stored.sessions.find((entry) => entry.id === id);
      assert.ok(Number.isFinite(Date.parse(actual.started_at)));
      const row = { id, project, ownership_mode: "shared", directory: dir, started_at: actual.started_at };
      assert.deepEqual(actual, row);
      const expected = structuredClone(before);
      expected.stored.sessions = [...(before.stored.sessions ?? []), row];
      expected.stats.total_sessions++;
      const ordered = (state) => ({ ...state, stored: { ...state.stored, sessions: [...state.stored.sessions].sort((a, b) => a.id.localeCompare(b.id)) } });
      assert.deepEqual(ordered(after), ordered(expected), "session seed is a separate public write");
      const title = `Prompt sentinel ${project}`;
      const saved = await http("/observations", "POST", { session_id: id, project, type: "note", scope: "project", title, content: title }, 201);
      assert.equal(saved.status, "saved");
      assert.ok(Number.isSafeInteger(saved.id) && saved.id > 0);
      seeded.push({ id: saved.id, title, project, session_id: id });
    }
    const snapshot = async () => {
      const state = await rawSnapshot();
      assert.equal(state.stored.observations.length, seeded.length);
      for (const project of ["parity", "other"]) assert.ok(state.stored.sessions.some((entry) => entry.id === `prompt-${project}`
        && entry.project === project && entry.directory === dir && entry.ownership_mode === "shared"));
      for (const expected of seeded) assert.ok(state.stored.observations.some((entry) => entry.id === expected.id
        && entry.title === expected.title && entry.content === expected.title && entry.project === expected.project
        && entry.session_id === expected.session_id));
      return state;
    };
    const tools = new Map();
    const sandbox = await createPluginSandbox(mkdtempSync(join(scratch, "save-prompt-pi-")));
    (await importPluginFromSandbox(sandbox))({ registerTool: (tool) => tools.set(tool.name, tool), on() {}, appendEntry() {} });
    const ctx = { cwd: dir, sessionManager: { getSessionId: () => "prompt-parity" }, ui: { setStatus() {} } };
    // Await the explicit project lock in this fresh module and same host directory.
    // Fix the different target BEFORE writing, never from write results.
    const beforePreparation = await snapshot();
    const preparation = await tools.get("mem_current_project").execute("prepare", { cwd: ctx.cwd }, undefined, undefined, ctx);
    assert.equal(preparation.isError, undefined, JSON.stringify(preparation));
    const resolved = preparation.details.data;
    assert.deepEqual(preparation.details, { data: resolved });
    assert.deepEqual(preparation.content, [{ type: "text", text: JSON.stringify(resolved, null, 2) }]);
    assert.deepEqual(resolved, { project: "other", project_source: "config", project_path: dir,
      cwd: ctx.cwd, available_projects: null });
    assert.deepEqual(await snapshot(), beforePreparation, "public project preparation is read-only");
    const piTarget = "parity";
    assert.notEqual(piTarget, resolved.project);
    const satelliteID = `${ctx.sessionManager.getSessionId()}@${piTarget}`;
    const call = async (transport, content) => {
      const args = { content, project: "parity", session_id: "prompt-parity" };
      if (transport === "HTTP") return http("/prompts", "POST", args, content ? 201 : 400);
      if (transport === "Pi") return tools.get("mem_save_prompt").execute("paired", { content, project: piTarget }, undefined, undefined, ctx);
      const envelope = await http("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mem_save_prompt", arguments: args } });
      assert.equal(envelope.error, undefined, JSON.stringify(envelope));
      return envelope.result;
    };
    const ordered = (state) => ({ ...state, stored: { ...state.stored,
      sessions: [...state.stored.sessions].sort((a, b) => a.id.localeCompare(b.id)),
      observations: [...state.stored.observations].sort((a, b) => a.id - b.id),
      prompts: [...(state.stored.prompts ?? [])].sort((a, b) => a.id - b.id),
      ...(state.stored.relations ? { relations: [...state.stored.relations].sort((a, b) => a.sync_id.localeCompare(b.sync_id)) } : {}),
    } });
    for (const transport of ["HTTP", "MCP", "Pi"]) {
      const content = `Prompt ${transport} distinct fixture`;
      const before = await snapshot();
      const result = await call(transport, content);
      const data = transport === "HTTP" ? result : transport === "Pi" ? result.details.data : JSON.parse(result.content[0].text);
      const after = await snapshot();
      const rows = after.stored.prompts.filter((entry) => !(before.stored.prompts ?? []).some((old) => old.id === entry.id));
      assert.equal(rows.length, 1);
      const actual = rows[0];
      assert.ok(Number.isSafeInteger(actual.id) && actual.id > 0);
      assert.equal(typeof actual.sync_id, "string");
      assert.ok(actual.sync_id.startsWith("prompt-") && !(before.stored.prompts ?? []).some((entry) => entry.sync_id === actual.sync_id));
      assert.ok(Number.isFinite(Date.parse(actual.created_at)));
      const expectedSessionID = transport === "Pi" ? satelliteID : "prompt-parity";
      const targetProject = transport === "Pi" ? piTarget : "parity";
      const row = { id: actual.id, sync_id: actual.sync_id, session_id: expectedSessionID, project: targetProject, content, created_at: actual.created_at };
      assert.deepEqual(actual, row, "complete public prompt fields, not a projected subset");
      if (transport === "HTTP") assert.deepEqual(data, { id: row.id, status: "saved" });
      else {
        assert.equal(result.isError, undefined);
        if (transport === "Pi") {
          assert.deepEqual(data, { prompt_id: row.id, status: "saved" });
          assert.deepEqual(result.details, { data });
        } else {
          assert.ok(Number.isSafeInteger(data.truncation.limit_bytes) && data.truncation.limit_bytes >= Buffer.byteLength(content));
          assert.deepEqual(data, { project: "parity", project_source: "session", project_path: dir, result: `Prompt saved: "${content}"`,
            truncation: { original_bytes: Buffer.byteLength(content), limit_bytes: data.truncation.limit_bytes, truncated: false } });
        }
        assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(data, null, transport === "Pi" ? 2 : undefined) }]);
      }
      const expected = structuredClone(before);
      expected.stored.prompts = [...(before.stored.prompts ?? []), row];
      expected.stats.total_prompts++;
      if (transport === "Pi") {
        assert.ok(!before.stored.sessions.some((entry) => entry.id === satelliteID), "satellite is not a seed");
        const satellite = after.stored.sessions.find((entry) => entry.id === satelliteID);
        assert.ok(satellite);
        assert.ok(Number.isFinite(Date.parse(satellite.started_at)));
        const sessionRow = { id: satelliteID, project: piTarget, ownership_mode: "project_owned", directory: "", started_at: satellite.started_at };
        assert.deepEqual(satellite, sessionRow, "complete isolated satellite session with no runtime directory");
        expected.stored.sessions.push(sessionRow);
        expected.stats.total_sessions++;
      }
      assert.deepEqual(ordered(after), ordered(expected), transport === "Pi"
        ? "exact satellite session/prompt additions and both counters; all other global fields unchanged"
        : "shared-session prompt addition/count only; all other global fields unchanged");
      const beforeRead = await snapshot();
      const recent = await http(`/prompts/recent?project=${targetProject}`);
      assert.deepEqual([...recent].sort((a, b) => a.id - b.id), after.stored.prompts.filter((entry) => entry.project === targetProject).sort((a, b) => a.id - b.id));
      assert.deepEqual(ordered(await snapshot()), ordered(beforeRead));
      const beforeReject = await snapshot();
      const rejected = await call(transport, "");
      if (transport === "HTTP") assert.deepEqual(rejected, { error: "session_id and content are required" });
      else {
        const error = transport === "MCP" ? "Failed to save prompt: prompt content is required" : "session_id and content are required";
        assert.equal(rejected.isError, true);
        assert.deepEqual(rejected.content, [{ type: "text", text: error }]);
        if (transport === "Pi") assert.deepEqual(rejected.details, { error, http_status: 400, data: { error } });
      }
      assert.deepEqual(ordered(await snapshot()), ordered(beforeReject), "empty-content rejection after satellite creation preserves complete global stored state/counters");
    }
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_URL; else process.env.ENGRAM_URL = previous;
    if (url) await fetch(`${url}/stop`, { method: "POST" });
    assert.equal(await exited, 0, output);
  }
});
