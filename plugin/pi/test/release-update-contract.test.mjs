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

// Public writes/history, not SDK validation or internal sync-queue evidence.
test("public updates preserve ownership and exact content/history effects across transports", async () => {
  const dir = mkdtempSync(join(scratch, "update-"));
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
    await http("/sessions", "POST", { id: "update-seed", project: "parity" }, 201);
    const fixtures = [];
    for (const transport of ["HTTP", "MCP", "Pi"]) {
      const title = `Update ${transport}`;
      const saved = await http("/observations", "POST", { session_id: "update-seed", project: "parity",
        type: "note", title, content: `old old OLD ${transport}`, scope: "project" }, 201);
      assert.equal(saved.status, "saved");
      assert.ok(Number.isSafeInteger(saved.id) && saved.id > 0);
      fixtures.push({ transport, id: saved.id, title });
    }
    const snapshot = async () => {
      const exported = await http("/export?all_projects=true");
      assert.equal(typeof exported.exported_at, "string");
      assert.ok(Number.isFinite(Date.parse(exported.exported_at)));
      assert.ok(exported.sessions.some((entry) => entry.id === "update-seed" && entry.project === "parity"));
      for (const { id, title } of fixtures) assert.ok(exported.observations.some((entry) => entry.id === id
        && entry.title === title && entry.project === "parity" && entry.session_id === "update-seed"));
      const { exported_at, ...stored } = exported;
      return { stored, stats: await http("/stats?all_projects=true") };
    };
    const rpc = async (args) => {
      const envelope = await http("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "mem_update", arguments: args } });
      assert.equal(envelope.error, undefined, JSON.stringify(envelope));
      return envelope.result;
    };
    const tools = new Map();
    const sandbox = await createPluginSandbox(mkdtempSync(join(scratch, "update-pi-")));
    (await importPluginFromSandbox(sandbox))({ registerTool: (tool) => tools.set(tool.name, tool), on() {}, appendEntry() {} });
    const ctx = { cwd: dir, sessionManager: { getSessionId: () => "update-host" }, ui: { setStatus() {} } };
    const pi = (args) => tools.get("mem_update").execute("paired", args, undefined, undefined, ctx);
    const history = (id) => http(`/observations/${id}?include_history=true`);
    const update = async (fixture, fields, content, { noop = false, type = "note" } = {}) => {
      const { id, transport, title } = fixture;
      const before = await snapshot();
      const prior = await history(id);
      const args = { id, expected_project: "parity", ...fields };
      let returned;
      if (transport === "HTTP") returned = await http(`/observations/${id}?expected_project=parity`, "PATCH", fields);
      else if (transport === "Pi") {
        const result = await pi(args);
        assert.notEqual(result.isError, true, JSON.stringify(result));
        returned = result.details.data;
        assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(returned, null, 2) }]);
      } else {
        const result = await rpc(args);
        assert.notEqual(result.isError, true, JSON.stringify(result));
        assert.equal(result.content.length, 1);
        assert.equal(result.content[0].type, "text");
        const envelope = JSON.parse(result.content[0].text);
        assert.equal(envelope.project, "parity");
        assert.equal(envelope.project_source, "process_override");
        assert.equal(envelope.project_path, "");
        assert.equal(envelope.result, `Memory updated: #${id} ${JSON.stringify(title)} (${type}, scope=project)`);
      }
      const after = await snapshot();
      const current = await history(id);
      const { history: versions, version_count, ...record } = current;
      if (returned) assert.deepEqual(returned, record, "complete HTTP/Pi update response equals public stored observation");
      const expected = structuredClone(before);
      const target = expected.stored.observations.find((entry) => entry.id === id);
      if (!noop) {
        target.content = content;
        target.type = type;
        target.revision_count += 1;
        const actual = after.stored.observations.find((entry) => entry.id === id);
        assert.ok(Number.isFinite(Date.parse(actual.updated_at)));
        assert.ok(Date.parse(actual.updated_at) >= Date.parse(target.updated_at));
        target.updated_at = actual.updated_at;
      }
      assert.deepEqual(after, expected, `${transport}: exactly expected target fields change; every other stored field/counter stable`);
      assert.equal(record.content, content);
      assert.equal(record.type, type);
      assert.equal(record.revision_count, prior.revision_count + (noop ? 0 : 1));
      if (content !== prior.content) {
        assert.equal(version_count, prior.version_count + 1);
        assert.equal(versions.length, prior.history.length + 1);
        assert.deepEqual(versions.slice(0, -1), prior.history, "complete old versions retained");
        const captured = versions.at(-1);
        assert.equal(captured.version, prior.revision_count);
        assert.equal(captured.title, prior.title);
        assert.equal(captured.content, prior.content);
        assert.ok(Number.isFinite(Date.parse(captured.created_at)));
        assert.deepEqual(Object.keys(captured).sort(), ["content", "created_at", "title", "version"]);
      } else {
        assert.equal(version_count, prior.version_count);
        assert.deepEqual(versions, prior.history, "no-op or metadata-only update adds no content history");
      }
    };
    for (const fixture of fixtures) {
      const full = `old old OLD ${fixture.transport} full`;
      await update(fixture, { content: full }, full);
      const replaced = `new new OLD ${fixture.transport} full`;
      await update(fixture, { find: "old", replace: "new" }, replaced);
      const removed = `OLD ${fixture.transport} full`;
      await update(fixture, { find: "new", replace: "" }, removed);
      await update(fixture, { find: "absent", replace: "ignored" }, removed, { noop: true });
      await update(fixture, { find: "absent", replace: "ignored", type: "decision" }, removed, { type: "decision" });
    }
    for (const fixture of fixtures) {
      const rejects = [
        [{ find: "OLD" }, "parity", 400, "find and replace must be provided together"],
        [{ find: "OLD", replace: "new", content: "conflict" }, "parity", 400, "find and replace cannot be combined with content"],
        [{ content: "forbidden" }, "other", 409, "expected_project does not match observation owner"],
        [{ content: "forbidden" }, undefined, 400, "expected_project must be a valid non-empty project name"],
        [{ content: "forbidden" }, " ", 400, "expected_project must be a valid non-empty project name"],
        [{ content: "forbidden" }, "../owner", 400, "expected_project must be a valid non-empty project name"],
      ];
      for (const [fields, expected_project, status, error] of rejects) {
        const before = await snapshot();
        const prior = await history(fixture.id);
        if (fixture.transport === "HTTP") {
          const query = expected_project === undefined ? "" : `?${new URLSearchParams({ expected_project })}`;
          const response = await fetch(`${url}/observations/${fixture.id}${query}`, { method: "PATCH",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields) });
          assert.equal(response.status, status);
          assert.equal(response.headers.get("content-type"), "application/json");
          assert.equal(await response.text(), `${JSON.stringify({ error })}\n`);
        } else {
          const args = { id: fixture.id, ...fields, ...(expected_project === undefined ? {} : { expected_project }) };
          const result = fixture.transport === "Pi" ? await pi(args) : await rpc(args);
          assert.equal(result.isError, true);
          const text = fixture.transport === "MCP" && ["parity", "other"].includes(expected_project)
            ? `Failed to update memory: ${error}` : error;
          assert.deepEqual(result.content, [{ type: "text", text }]);
          if (fixture.transport === "Pi") assert.deepEqual(result.details, { error, http_status: status, data: { error } });
        }
        assert.deepEqual(await snapshot(), before, "rejected update preserves global records/counters");
        assert.deepEqual(await history(fixture.id), prior, "rejected update preserves complete public history");
      }
      const before = await snapshot();
      const prior = await history(fixture.id);
      const id = fixture.id + 1000000;
      const fields = { find: "old", replace: "new" };
      const error = "observation not found";
      if (fixture.transport === "HTTP") {
        assert.deepEqual(await http(`/observations/${id}?expected_project=parity`, "PATCH", fields, 404), { error });
      } else {
        const args = { id, expected_project: "parity", ...fields };
        const result = fixture.transport === "Pi" ? await pi(args) : await rpc(args);
        assert.equal(result.isError, true);
        assert.deepEqual(result.content, [{ type: "text", text: fixture.transport === "MCP" ? "Failed to update memory: sql: no rows in result set" : error }]);
        if (fixture.transport === "Pi") assert.deepEqual(result.details, { error, http_status: 404, data: { error } });
      }
      assert.deepEqual(await snapshot(), before, "missing-ID updates preserve global records/counters");
      assert.deepEqual(await history(fixture.id), prior, "missing-ID updates preserve public history");
    }
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_URL; else process.env.ENGRAM_URL = previous;
    if (url) await fetch(`${url}/stop`, { method: "POST" });
    assert.equal(await exited, 0, output);
  }
});
