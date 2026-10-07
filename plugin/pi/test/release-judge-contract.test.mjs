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

// Public comparison seeds an ALREADY-JUDGED relation, not a pending candidate.
test("public judge overwrites existing verdicts with exact effects and transport provenance", async () => {
  const dir = mkdtempSync(join(scratch, "judge-"));
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
    for (const project of ["parity", "other"]) await http("/sessions", "POST", { id: `judge-${project}`, project }, 201);
    const seeded = [];
    const pairs = [];
    for (const transport of ["HTTP", "MCP", "Pi"]) {
      const pair = [];
      for (const suffix of ["a", "b"]) {
        const title = `Judge ${transport} ${suffix}`;
        const saved = await http("/observations", "POST", { session_id: "judge-parity", project: "parity",
          type: "note", scope: "project", title, content: title }, 201);
        assert.equal(saved.status, "saved");
        assert.ok(Number.isSafeInteger(saved.id) && saved.id > 0);
        seeded.push({ id: saved.id, title, project: "parity", session_id: "judge-parity" });
        pair.push(saved.id);
      }
      pairs.push({ transport, pair });
    }
    const foreign = await http("/observations", "POST", { session_id: "judge-other", project: "other",
      type: "note", scope: "project", title: "Judge foreign", content: "Judge foreign" }, 201);
    assert.equal(foreign.status, "saved");
    seeded.push({ id: foreign.id, title: "Judge foreign", project: "other", session_id: "judge-other" });
    const snapshot = async () => {
      const exported = await http("/export?all_projects=true");
      assert.ok(Number.isFinite(Date.parse(exported.exported_at)));
      for (const project of ["parity", "other"]) assert.ok(exported.sessions.some((entry) => entry.id === `judge-${project}` && entry.project === project));
      assert.equal(exported.observations.length, seeded.length);
      for (const expected of seeded) assert.ok(exported.observations.some((entry) => entry.id === expected.id
        && entry.title === expected.title && entry.content === expected.title && entry.project === expected.project
        && entry.session_id === expected.session_id));
      const { exported_at, ...stored } = exported;
      return { stored, stats: await http("/stats?all_projects=true") };
    };
    const ordered = (state) => ({ ...state, stored: { ...state.stored,
      relations: [...(state.stored.relations ?? [])].sort((a, b) => a.sync_id.localeCompare(b.sync_id)) } });
    const tools = new Map();
    const sandbox = await createPluginSandbox(mkdtempSync(join(scratch, "judge-pi-")));
    (await importPluginFromSandbox(sandbox))({ registerTool: (tool) => tools.set(tool.name, tool), on() {}, appendEntry() {} });
    const ctx = { cwd: dir, sessionManager: { getSessionId: () => "judge-host" }, ui: { setStatus() {} } };
    const call = async (transport, args) => {
      if (transport === "HTTP") return http("/conflicts/judge", "POST", args);
      if (transport === "Pi") return tools.get("mem_judge").execute("paired", args, undefined, undefined, ctx);
      const envelope = await http("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "mem_judge", arguments: args } });
      assert.equal(envelope.error, undefined, JSON.stringify(envelope));
      return envelope.result;
    };
    const publicRelations = async () => {
      const before = await snapshot();
      const list = await http("/conflicts?all_projects=true");
      const stats = await http("/conflicts/stats?all_projects=true");
      assert.deepEqual(ordered(await snapshot()), ordered(before));
      const visible = (before.stored.relations ?? []).filter((entry) => entry.relation !== "not_conflict");
      assert.equal(list.total, visible.length);
      assert.equal(list.relations.length, visible.length);
      assert.deepEqual(list.relations.map((entry) => entry.sync_id).sort(), visible.map((entry) => entry.sync_id).sort());
      const counts = {};
      for (const entry of visible) counts[entry.relation] = (counts[entry.relation] ?? 0) + 1;
      assert.deepEqual(stats, { project: "", by_relation: counts, by_judgment_status: visible.length ? { judged: visible.length } : {}, deferred: 0, dead: 0 });
      return { list, stats };
    };
    for (const { transport, pair } of pairs) {
      // Assert comparison's write separately, so judge cannot inherit credit for it.
      const beforeSeed = await snapshot();
      const seed = await http("/conflicts/compare", "POST", { memory_id_a: pair[0], memory_id_b: pair[1],
        relation: "supersedes", confidence: 0.8, reasoning: "Seed verdict", model: "fixture-model" });
      assert.deepEqual(Object.keys(seed), ["sync_id"]);
      assert.ok(seed.sync_id.startsWith("rel-"));
      const afterSeed = await snapshot();
      const row = afterSeed.stored.relations.find((entry) => entry.sync_id === seed.sync_id);
      assert.ok(row);
      assert.ok(Number.isFinite(Date.parse(row.created_at)) && Number.isFinite(Date.parse(row.updated_at)));
      assert.ok(Date.parse(row.updated_at) >= Date.parse(row.created_at));
      const expectedSeed = { sync_id: seed.sync_id,
        source_id: beforeSeed.stored.observations.find((entry) => entry.id === pair[0]).sync_id,
        target_id: beforeSeed.stored.observations.find((entry) => entry.id === pair[1]).sync_id,
        relation: "supersedes", confidence: 0.8, reason: "Seed verdict", judgment_status: "judged",
        marked_by_actor: "engram", marked_by_kind: "system", marked_by_model: "fixture-model",
        created_at: row.created_at, updated_at: row.updated_at };
      assert.deepEqual(row, expectedSeed);
      const seedState = structuredClone(beforeSeed);
      seedState.stored.relations = [...(beforeSeed.stored.relations ?? []), expectedSeed];
      assert.deepEqual(ordered(afterSeed), ordered(seedState));
      for (const fields of [
        { relation: "related", reason: "Explicit verdict", evidence: '{"fixture":true}', confidence: 0.7, session_id: "judge-parity" },
        { relation: "not_conflict" },
        { relation: "compatible" },
      ]) {
        const before = await snapshot();
        const old = before.stored.relations.find((entry) => entry.sync_id === seed.sync_id);
        const result = await call(transport, { judgment_id: seed.sync_id, ...fields });
        const data = transport === "HTTP" ? result : transport === "Pi" ? result.details.data : JSON.parse(result.content[0].text);
        assert.deepEqual(Object.keys(data), ["relation"]);
        const returned = data.relation;
        assert.ok(Number.isSafeInteger(returned.id) && returned.id > 0);
        const after = await snapshot();
        const actual = after.stored.relations.find((entry) => entry.sync_id === seed.sync_id);
        assert.ok(Number.isFinite(Date.parse(actual.updated_at)));
        assert.ok(Date.parse(actual.updated_at) >= Date.parse(old.updated_at));
        const expectedRow = { sync_id: seed.sync_id, source_id: old.source_id, target_id: old.target_id,
          ...fields, judgment_status: "judged", marked_by_actor: "agent", marked_by_kind: "agent",
          ...(!fields.session_id && transport === "Pi" ? { session_id: "judge-host" } : {}),
          created_at: old.created_at, updated_at: actual.updated_at };
        assert.deepEqual(actual, expectedRow, "complete exported judgment; model and omitted fields clear");
        assert.deepEqual(returned, { id: returned.id, ...expectedRow }, "complete public returned relation");
        if (transport !== "HTTP") {
          assert.equal(result.isError, undefined);
          assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(data, null, transport === "Pi" ? 2 : undefined) }]);
          if (transport === "Pi") assert.deepEqual(result.details, { data });
        }
        const expected = structuredClone(before);
        expected.stored.relations = before.stored.relations.map((entry) => entry.sync_id === seed.sync_id ? expectedRow : entry);
        assert.deepEqual(ordered(after), ordered(expected), "only target relation changes; every other global field/counter preserved");
        await publicRelations();
      }
      const valid = { judgment_id: seed.sync_id, relation: "related" };
      const cases = [
        [{ ...valid, judgment_id: "rel-does-not-exist" }, 'JudgeRelation: relation "rel-does-not-exist" not found'],
        [{ ...valid, relation: "invalidverb" }, 'JudgeRelation: invalid relation verb "invalidverb" — must be one of: related, compatible, scoped, conflicts_with, supersedes, not_conflict'],
        [{ relation: "related" }, "judgment_id is required"],
        [{ judgment_id: seed.sync_id }, "relation is required"],
      ];
      for (const [args, error] of cases) {
        const before = await snapshot();
        const prior = await publicRelations();
        if (transport === "HTTP") {
          const result = await http("/conflicts/judge", "POST", args, 400);
          assert.deepEqual(result, { error });
        } else {
          const result = await call(transport, args);
          assert.equal(result.isError, true);
          assert.deepEqual(result.content, [{ type: "text", text: error }]);
          if (transport === "Pi") assert.deepEqual(result.details, { error, http_status: 400, data: { error } });
        }
        assert.deepEqual(ordered(await snapshot()), ordered(before), "rejection preserves complete global stored state/counters");
        assert.deepEqual(await publicRelations(), prior);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_URL; else process.env.ENGRAM_URL = previous;
    if (url) await fetch(`${url}/stop`, { method: "POST" });
    assert.equal(await exited, 0, output);
  }
});
