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
const scratch = join(common, "gentle-checks/t2-parity/passive-contract-owned");
mkdirSync(scratch, { recursive: true });

test("passive capture shares extraction effects while preserving source and host variants", async () => {
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
  // Project-list ordering is not a contract; retain every value and counter.
  const ordered = (state) => ({ ...state,
    stats: { ...state.stats, projects: state.stats.projects === null ? null : [...state.stats.projects].sort() },
    stored: { ...state.stored,
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
    const beforeSeed = await snapshot();
    assert.deepEqual(await http("/sessions", "POST", { id: "passive-parity", project: "parity", directory: dir }, 201), { id: "passive-parity", status: "created" });
    const afterSeed = await snapshot();
    const seed = afterSeed.stored.sessions.find((row) => row.id === "passive-parity");
    timestamp(seed.started_at);
    assert.deepEqual(seed, { id: "passive-parity", project: "parity", ownership_mode: "shared", directory: dir, started_at: seed.started_at });
    const expectedSeed = structuredClone(beforeSeed);
    expectedSeed.stored.sessions = [...(expectedSeed.stored.sessions ?? []), seed];
    expectedSeed.stats.total_sessions++;
    assert.deepEqual(ordered(afterSeed), ordered(expectedSeed));
    const tools = new Map();
    const sandbox = await createPluginSandbox(mkdtempSync(join(scratch, "pi-")));
    (await importPluginFromSandbox(sandbox))({ registerTool: (tool) => tools.set(tool.name, tool), on() {}, appendEntry() {} });
    const ctx = { cwd: dir, sessionManager: { getSessionId: () => "passive-pi" }, ui: { setStatus() {} } };
    const beforePreparation = await snapshot();
    const preparation = await tools.get("mem_current_project").execute("prepare", { cwd: dir }, undefined, undefined, ctx);
    const resolved = { project: "other", project_source: "config", project_path: dir, cwd: dir, available_projects: null };
    assert.deepEqual(preparation.details, { data: resolved });
    assert.deepEqual(preparation, { content: [{ type: "text", text: JSON.stringify(preparation.details.data, null, 2) }], details: { data: resolved } });
    assert.deepEqual(ordered(await snapshot()), ordered(beforePreparation));
    const call = async (transport, content, source) => {
      if (transport === "HTTP") return http("/observations/passive", "POST", {
        session_id: "passive-parity", project: "parity", content, source: source ?? "http-passive",
      });
      if (transport === "Pi") return tools.get("mem_capture_passive").execute("paired", { content, ...(source === undefined ? {} : { source }) }, undefined, undefined, ctx);
      const envelope = await http("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "mem_capture_passive", arguments: { content, session_id: "passive-parity", ...(source === undefined ? {} : { source }) },
      } });
      assert.equal(envelope.error, undefined, JSON.stringify(envelope));
      return envelope.result;
    };
    const checkResult = (transport, result, extracted, saved, duplicates) => {
      const counts = { extracted, saved, duplicates };
      if (transport === "HTTP") assert.deepEqual(result, counts);
      else if (transport === "Pi") {
        assert.deepEqual(result.details, { data: counts });
        assert.deepEqual(result, {
          content: [{ type: "text", text: JSON.stringify(result.details.data, null, 2) }], details: { data: counts },
        });
      } else {
        const actual = JSON.parse(result.content[0].text);
        assert.deepEqual(actual, {
          project: "parity", project_source: "session", project_path: dir,
          result: `Passive capture complete: extracted=${extracted} saved=${saved} duplicates=${duplicates}`,
        });
        assert.deepEqual(result, { content: [{ type: "text", text: JSON.stringify(actual) }] });
      }
    };
    // No extraction still performs Pi's first host registration; do not hide it.
    const beforeHost = await snapshot();
    checkResult("Pi", await call("Pi", "No learning section"), 0, 0, 0);
    const afterHost = await snapshot();
    const host = afterHost.stored.sessions.find((row) => row.id === "passive-pi");
    timestamp(host.started_at);
    assert.deepEqual(host, { id: "passive-pi", project: "other", ownership_mode: "project_owned", directory: dir, started_at: host.started_at });
    const expectedHost = structuredClone(beforeHost);
    expectedHost.stored.sessions.push(host);
    expectedHost.stats.total_sessions++;
    assert.deepEqual(ordered(afterHost), ordered(expectedHost));

    const fixtures = [
      ["HTTP", "aaaa bbbb cccc ddddd", "http-passive", "parity", "passive-parity"],
      ["MCP", "eeee ffff gggg hhhhh", "mcp-passive", "parity", "passive-parity"],
      ["Pi", "iiii jjjj kkkk lllll", "pi-tool", "other", "passive-pi"],
    ];
    for (const [transport, learning, source, project, sessionID] of fixtures) {
      assert.equal(learning.length, 20);
      assert.equal(learning.split(" ").length, 4);
      for (const content of ["No learning section", "## Key Learnings:\n- aaaa bbbb cccc dddd", "## Key Learnings:\n- aaaaaa bbbbbb ccccccc"]) {
        const before = await snapshot();
        checkResult(transport, await call(transport, content), 0, 0, 0);
        assert.deepEqual(ordered(await snapshot()), ordered(before), "missing section, 19 bytes or fewer than four words produce no observations or counter changes");
      }
      const content = `## Key Learnings:\n- Earlier valid learning should not persist\n## Next\nText\n## Key Learnings:\n1. **${learning.split(" ")[0]}** ${learning.split(" ").slice(1).join(" ")}\n## After\n- Excluded valid learning should not persist`;
      const before = await snapshot();
      checkResult(transport, await call(transport, content), 1, 1, 0);
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
      const row = { id: actual.id, sync_id: actual.sync_id, session_id: sessionID, type: "passive", title: learning,
        content: learning, tool_name: source, project, scope: "project", revision_count: 1, duplicate_count: 1,
        last_seen_at: actual.last_seen_at, created_at: actual.created_at, updated_at: actual.updated_at, pinned: false };
      assert.deepEqual(actual, row, "complete passive observation and source default");
      const expected = structuredClone(before);
      expected.stored.observations.push(row);
      expected.stats.total_observations++;
      expected.stats.projects = project === "other" ? ["other", "parity"] : ["parity"];
      assert.deepEqual(ordered(after), ordered(expected), "only one extracted observation and its global counters change");
      for (const explicitSource of [undefined, "explicit-source"]) {
        const beforeDuplicate = await snapshot();
        checkResult(transport, await call(transport, `## Key Learnings:\n- ${learning}`, explicitSource), 1, 0, 1);
        assert.deepEqual(ordered(await snapshot()), ordered(beforeDuplicate), "passive duplicates do not increment observation duplicate_count or overwrite source");
      }
      const beforeEmpty = await snapshot();
      const empty = await call(transport, "");
      if (transport === "MCP") assert.deepEqual(empty, { isError: true, content: [{ type: "text", text: "content is required — include text with a '## Key Learnings:' section" }] });
      else checkResult(transport, empty, 0, 0, 0);
      assert.deepEqual(ordered(await snapshot()), ordered(beforeEmpty), "empty-content variant has no stored effects after registration");
    }
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_URL; else process.env.ENGRAM_URL = previous;
    if (url) await fetch(`${url}/stop`, { method: "POST" });
    assert.equal(await exited, 0, output);
  }
});
