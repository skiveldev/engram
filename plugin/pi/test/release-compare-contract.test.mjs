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

// Compare persists an externally judged verdict; this fixture runs no model.
test("public comparison persists exact relation effects and preserves unrelated global state", async () => {
  const dir = mkdtempSync(join(scratch, "compare-"));
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
    const seeded = [];
    const pairs = [];
    for (const project of ["parity", "other"]) await http("/sessions", "POST", { id: `compare-${project}`, project }, 201);
    for (const transport of ["HTTP", "MCP", "Pi"]) {
      const pair = [];
      for (const suffix of ["a", "b"]) {
        const title = `Compare ${transport} ${suffix}`;
        const saved = await http("/observations", "POST", { session_id: "compare-parity", project: "parity",
          type: "note", scope: "project", title, content: title }, 201);
        assert.equal(saved.status, "saved");
        assert.ok(Number.isSafeInteger(saved.id) && saved.id > 0);
        seeded.push({ id: saved.id, title, project: "parity" });
        pair.push(saved.id);
      }
      pairs.push({ transport, pair });
    }
    const foreign = await http("/observations", "POST", { session_id: "compare-other", project: "other",
      type: "note", scope: "project", title: "Compare foreign", content: "Compare foreign" }, 201);
    assert.equal(foreign.status, "saved");
    seeded.push({ id: foreign.id, title: "Compare foreign", project: "other" });
    const snapshot = async () => {
      const exported = await http("/export?all_projects=true");
      assert.equal(typeof exported.exported_at, "string");
      assert.ok(Number.isFinite(Date.parse(exported.exported_at)));
      for (const project of ["parity", "other"]) assert.ok(exported.sessions.some((entry) => entry.id === `compare-${project}` && entry.project === project));
      for (const { id, title, project } of seeded) assert.ok(exported.observations.some((entry) => entry.id === id
        && entry.title === title && entry.content === title && entry.project === project));
      const { exported_at, ...stored } = exported;
      return { stored, stats: await http("/stats?all_projects=true") };
    };
    const tools = new Map();
    const sandbox = await createPluginSandbox(mkdtempSync(join(scratch, "compare-pi-")));
    (await importPluginFromSandbox(sandbox))({ registerTool: (tool) => tools.set(tool.name, tool), on() {}, appendEntry() {} });
    const ctx = { cwd: dir, sessionManager: { getSessionId: () => "compare-host" }, ui: { setStatus() {} } };
    const call = async (transport, args) => {
      if (transport === "HTTP") return http("/conflicts/compare", "POST", args);
      if (transport === "Pi") return tools.get("mem_compare").execute("paired", args, undefined, undefined, ctx);
      const envelope = await http("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "mem_compare", arguments: args } });
      assert.equal(envelope.error, undefined, JSON.stringify(envelope));
      return envelope.result;
    };
    const publicRelations = async () => {
      const before = await snapshot();
      const list = await http("/conflicts?all_projects=true");
      const stats = await http("/conflicts/stats?all_projects=true");
      assert.deepEqual(await snapshot(), before, "relation reads preserve complete global records/counters");
      const visible = (before.stored.relations ?? []).filter((entry) => entry.relation !== "not_conflict");
      assert.equal(list.total, visible.length);
      assert.equal(list.relations.length, visible.length);
      assert.deepEqual(list.relations.map((entry) => entry.sync_id).sort(), visible.map((entry) => entry.sync_id).sort());
      const counts = {};
      for (const entry of visible) counts[entry.relation] = (counts[entry.relation] ?? 0) + 1;
      assert.deepEqual(stats, { project: "", by_relation: counts, by_judgment_status: visible.length ? { judged: visible.length } : {}, deferred: 0, dead: 0 });
      for (const entry of list.relations) {
        const stored = visible.find((item) => item.sync_id === entry.sync_id);
        assert.equal(entry.relation, stored.relation);
        assert.equal(entry.judgment_status, "judged");
      }
      return { list, stats };
    };
    await publicRelations();
    for (const { transport, pair } of pairs) {
      let syncID;
      for (const [index, relation] of ["supersedes", "not_conflict", "related"].entries()) {
        const [memory_id_a, memory_id_b] = index === 2 ? [...pair].reverse() : pair;
        const args = { memory_id_a, memory_id_b, relation, confidence: 0.8, reasoning: `Existing verdict ${index}`,
          ...(index === 0 ? { model: "fixture-model" } : {}) };
        const before = await snapshot();
        const result = await call(transport, args);
        let data = result;
        if (transport !== "HTTP") {
          assert.notEqual(result.isError, true, JSON.stringify(result));
          data = transport === "Pi" ? result.details.data : JSON.parse(result.content[0].text);
        }
        assert.deepEqual(Object.keys(data), ["sync_id"]);
        assert.equal(typeof data.sync_id, "string");
        assert.ok(data.sync_id.startsWith("rel-"));
        if (syncID) assert.equal(data.sync_id, syncID, "same pair, including reverse direction, reuses portable relation identity");
        syncID = data.sync_id;
        if (transport === "Pi") assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(data, null, 2) }]);
        if (transport === "MCP") assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(data) }]);
        const after = await snapshot();
        const actual = after.stored.relations.find((entry) => entry.sync_id === syncID);
        assert.ok(actual);
        assert.ok(Number.isFinite(Date.parse(actual.created_at)));
        assert.ok(Number.isFinite(Date.parse(actual.updated_at)));
        assert.ok(Date.parse(actual.updated_at) >= Date.parse(actual.created_at));
        const old = (before.stored.relations ?? []).find((entry) => entry.sync_id === syncID);
        if (old) {
          assert.equal(actual.created_at, old.created_at);
          assert.ok(Date.parse(actual.updated_at) >= Date.parse(old.updated_at));
        }
        const expectedRow = { sync_id: syncID,
          source_id: before.stored.observations.find((entry) => entry.id === memory_id_a).sync_id,
          target_id: before.stored.observations.find((entry) => entry.id === memory_id_b).sync_id,
          relation, confidence: args.confidence, reason: args.reasoning, judgment_status: "judged",
          marked_by_actor: "engram", marked_by_kind: "system", ...(args.model ? { marked_by_model: args.model } : {}),
          created_at: old?.created_at ?? actual.created_at, updated_at: actual.updated_at };
        assert.deepEqual(actual, expectedRow, "complete relation judgment/provenance fields");
        const expected = structuredClone(before);
        expected.stored.relations = old ? before.stored.relations.map((entry) => entry.sync_id === syncID ? expectedRow : entry)
          : [...(before.stored.relations ?? []), expectedRow];
        const orderedCopy = (snapshot) => ({ ...snapshot, stored: { ...snapshot.stored,
          relations: [...(snapshot.stored.relations ?? [])].sort((a, b) => a.sync_id.localeCompare(b.sync_id)) } });
        assert.deepEqual(orderedCopy(after), orderedCopy(expected), "complete relation records independent of export order; all other global fields/counters preserved");
        await publicRelations();
      }
    }
    for (const { transport, pair } of pairs) {
      const valid = { memory_id_a: pair[0], memory_id_b: pair[1], relation: "related", confidence: 0.8, reasoning: "Existing verdict" };
      const { confidence, ...withoutConfidence } = valid;
      const cases = [
        [withoutConfidence, transport === "MCP" ? "confidence is required (float 0.0..1.0)" : "confidence is required"],
        [{ ...valid, confidence: 1.5 }, "confidence must be between 0.0 and 1.0"],
        [{ ...valid, relation: "invalid" }, 'JudgeBySemantic: invalid relation verb "invalid" — must be one of: related, compatible, scoped, conflicts_with, supersedes, not_conflict'],
        [{ ...valid, memory_id_b: foreign.id }, "relation rejected: source and target observations are in different projects"],
      ];
      for (const [args, error] of cases) {
        const before = await snapshot();
        const prior = await publicRelations();
        if (transport === "HTTP") {
          const response = await fetch(`${url}/conflicts/compare`, { method: "POST",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) });
          assert.equal(response.status, 400);
          assert.equal(response.headers.get("content-type"), "application/json");
          assert.equal(await response.text(), `${JSON.stringify({ error })}\n`);
        } else {
          const result = await call(transport, args);
          assert.equal(result.isError, true);
          assert.deepEqual(result.content, [{ type: "text", text: error }]);
          if (transport === "Pi") assert.deepEqual(result.details, { error, http_status: 400, data: { error } });
        }
        assert.deepEqual(await snapshot(), before, "rejection preserves all global records and counters");
        assert.deepEqual(await publicRelations(), prior, "rejection preserves complete conflict list/statistics");
      }
    }
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_URL; else process.env.ENGRAM_URL = previous;
    if (url) await fetch(`${url}/stop`, { method: "POST" });
    assert.equal(await exited, 0, output);
  }
});
