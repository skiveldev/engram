import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createPluginSandbox, importPluginFromSandbox } from "./plugin-sandbox.mjs";

// Real public core effects; registered execution is not SDK validation.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
const scratch = join(common, "gentle-checks/t2-parity");
mkdirSync(scratch, { recursive: true });

test("public search and all-known projects preserve state and explicit transport variants", async (t) => {
  const dir = mkdtempSync(join(scratch, "search-projects-"));
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
    const expectedSeeds = [];
    const snapshot = async () => {
      const exported = await http("/export?all_projects=true");
      for (const { project, id } of expectedSeeds) {
        assert.ok(Array.isArray(exported.sessions));
        assert.ok(Array.isArray(exported.observations));
        assert.ok(exported.sessions.some((entry) => entry.id === `search-${project}` && entry.project === project));
        assert.ok(exported.observations.some((entry) => entry.id === id && entry.project === project
          && entry.session_id === `search-${project}` && entry.title === `${marker} ${project}` && entry.content === content));
      }
      assert.equal(typeof exported.exported_at, "string");
      assert.ok(Number.isFinite(Date.parse(exported.exported_at)));
      const { exported_at, ...stored } = exported;
      return { stored, stats: await http("/stats?all_projects=true") };
    };
    const read = async (label, operation) => {
      const before = await snapshot();
      try { return await operation(); }
      finally { assert.deepEqual(await snapshot(), before, `${label}: all stored fields and counters unchanged`); }
    };
    const tools = new Map();
    const sandbox = await createPluginSandbox(mkdtempSync(join(scratch, "search-projects-pi-")));
    (await importPluginFromSandbox(sandbox))({ registerTool: (tool) => tools.set(tool.name, tool), on() {}, appendEntry() {} });
    const ctx = { cwd: dir, sessionManager: { getSessionId: () => "search-projects-host" }, ui: { setStatus() {} } };
    const pi = (name, args) => read(`Pi ${name}`, () => tools.get(name).execute("paired", args, undefined, undefined, ctx));
    const rpc = (name, args) => read(`MCP ${name}`, async () => {
      const envelope = await http("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      assert.equal(envelope.error, undefined, JSON.stringify(envelope));
      return envelope.result;
    });
    const mcpData = (result) => {
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(result.content.length, 1);
      assert.equal(result.content[0].type, "text");
      return JSON.parse(result.content[0].text);
    };
    const projects = async (expectedCount) => {
      const data = await read("HTTP projects", () => http("/projects"));
      assert.equal(data.count, expectedCount);
      assert.equal(data.projects.length, expectedCount);
      const mcp = mcpData(await rpc("mem_list_projects", {}));
      const result = await pi("mem_list_projects", {});
      assert.notEqual(result.isError, true);
      const orderedCopy = (payload) => ({
        ...payload,
        projects: [...payload.projects].sort((a, b) => a.name.localeCompare(b.name)),
      });
      const orders = JSON.stringify({ http: data.projects.map((entry) => entry.name),
        mcp: mcp.projects.map((entry) => entry.name), pi: result.details.data.projects.map((entry) => entry.name) });
      assert.deepEqual(orderedCopy(mcp), orderedCopy(data), `complete MCP project records; original orders: ${orders}`);
      assert.deepEqual(orderedCopy(result.details.data), orderedCopy(data), `complete Pi project records; original orders: ${orders}`);
      return data;
    };
    await projects(0);
    const marker = "pairedsearchuniquemarker";
    const content = `${marker}\n${"界🙂".repeat(180)}END`;
    const ids = new Map();
    for (const project of ["parity", "other"]) {
      await http("/sessions", "POST", { id: `search-${project}`, project }, 201);
      const saved = await http("/observations", "POST", {
        session_id: `search-${project}`, project, scope: "project", type: "note", title: `${marker} ${project}`, content,
      }, 201);
      assert.equal(saved.status, "saved");
      assert.ok(Number.isSafeInteger(saved.id) && saved.id > 0);
      ids.set(project, saved.id);
      expectedSeeds.push({ project, id: saved.id });
    }
    assert.notEqual(ids.get("parity"), ids.get("other"));
    const listed = await projects(2);
    assert.deepEqual(listed.projects.map((entry) => entry.name).sort(), ["other", "parity"]);
    for (const entry of listed.projects) {
      assert.equal(entry.observation_count, 1);
      assert.equal(entry.session_count, 1);
    }
    const searchHTTP = (args) => {
      const query = new URLSearchParams(Object.entries(args).map(([key, value]) => [key === "query" ? "q" : key, String(value)]));
      return read("HTTP search", () => http(`/search?${query}`));
    };
    const envelope = (result, global = false) => {
      const data = mcpData(result);
      assert.equal(data.project, global ? "" : "parity");
      assert.equal(typeof data.project_source, "string");
      assert.ok(Object.hasOwn(data, "project_path"));
      assert.equal(typeof data.result, "string");
      return data;
    };
    const identity = (results, expected) => {
      assert.deepEqual(results.map((entry) => entry.id).sort((a, b) => a - b), expected.slice().sort((a, b) => a - b));
      for (const entry of results) {
        assert.equal(entry.id, ids.get(entry.project));
        assert.equal(entry.type, "note");
        assert.equal(entry.scope, "project");
        assert.equal(entry.title, `${marker} ${entry.project}`);
        assert.equal(typeof entry.sync_id, "string");
        assert.ok(entry.sync_id.length > 0);
      }
    };
    for (const response_format of [undefined, "compact"]) {
      const args = { query: marker, project: "parity", ...(response_format ? { response_format } : {}) };
      const data = await searchHTTP(args);
      identity(data, [ids.get("parity")]);
      const result = await pi("mem_search", args);
      assert.notEqual(result.isError, true);
      assert.deepEqual(result.details.data, data, "complete HTTP payload is retained by Pi");
      assert.equal(result.content[0].type, "text");
      const mcp = envelope(await rpc("mem_search", args));
      identity(mcp.results, [ids.get("parity")]);
      if (response_format) {
        assert.deepEqual(mcp.results, data, "all compact fields, including optional relations");
        assert.equal(mcp.result, "Found 1 memories.");
        assert.equal(Object.hasOwn(data[0], "content"), false);
        assert.equal([...data[0].preview].length, 300);
        assert.equal(data[0].truncated, true);
        assert.equal(data[0].preview, [...content].slice(0, 300).join(""));
      } else {
        assert.equal(data[0].content, content);
        assert.equal(Object.hasOwn(mcp.results[0], "preview"), false);
        assert.equal(Object.hasOwn(mcp.results[0], "content"), false);
        for (const [key, value] of Object.entries(mcp.results[0])) {
          if (Object.hasOwn(data[0], key)) assert.deepEqual(data[0][key], value, `legacy shared ${key}`);
          else assert.ok(["state", "pinned"].includes(key), `unmapped legacy transport field ${key}`);
        }
        assert.ok(mcp.result.startsWith("Found 1 memories:\n\n"));
        assert.ok(mcp.result.includes(`#${ids.get("parity")} (note)`));
        assert.ok(mcp.result.includes("[preview]"));
        assert.ok(mcp.result.includes("mem_get_observation"));
      }
    }
    for (const response_format of [undefined, "compact"]) {
      const args = { query: "unmatchedsearchmarker", project: "parity", ...(response_format ? { response_format } : {}) };
      assert.deepEqual(await searchHTTP(args), []);
      const result = await pi("mem_search", args);
      assert.notEqual(result.isError, true);
      assert.deepEqual(result.details.data, []);
      assert.deepEqual(result.content, [{ type: "text", text: "No memories found" }]);
      const mcp = envelope(await rpc("mem_search", args));
      assert.equal(mcp.result, 'No memories found for: "unmatchedsearchmarker"');
      assert.equal(Object.hasOwn(mcp, "results"), false, "empty MCP response is prose, not fabricated metadata");
    }
    for (const response_format of [undefined, "compact"]) {
      const args = { query: marker, all_projects: true, ...(response_format ? { response_format } : {}) };
      const data = await searchHTTP(args);
      identity(data, [...ids.values()]);
      const result = await pi("mem_search", args);
      assert.notEqual(result.isError, true);
      assert.deepEqual(result.details.data, data);
      const mcp = envelope(await rpc("mem_search", args), true);
      identity(mcp.results, [...ids.values()]);
      if (response_format) assert.deepEqual(mcp.results, data);
    }
    const rejectHTTP = async (args, expected) => {
      const query = new URLSearchParams(Object.entries(args).map(([key, value]) => [key === "query" ? "q" : key, String(value)]));
      await read("rejected HTTP search", async () => {
        const response = await fetch(`${url}/search?${query}`);
        assert.equal(response.status, 400);
        assert.equal(response.headers.get("content-type"), "application/json");
        assert.equal(await response.text(), `${JSON.stringify(expected)}\n`);
      });
    };
    const rejectHTTPPi = async (args, expected) => {
      await rejectHTTP(args, expected);
      const result = await pi("mem_search", args);
      assert.equal(result.isError, true);
      assert.deepEqual(result.content, [{ type: "text", text: expected.error }]);
      assert.deepEqual(result.details, { error: expected.error, http_status: 400, data: expected });
    };
    const badFormat = { query: marker, project: "parity", response_format: "verbose" };
    const formatError = 'invalid response_format "verbose": must be "compact"';
    await rejectHTTPPi(badFormat, { error: formatError });
    const rejectedMCP = await rpc("mem_search", badFormat);
    assert.equal(rejectedMCP.isError, true);
    assert.deepEqual(rejectedMCP.content, [{ type: "text", text: formatError }]);
    for (const response_format of [undefined, "compact"]) {
      const args = { query: marker, project: "parity", all_projects: true, ...(response_format ? { response_format } : {}) };
      await rejectHTTP(args, {
        code: "invalid_project",
        error: "project resolution failed: invalid project name: project and all_projects cannot be used together",
      });
      const { project, ...globalArgs } = args;
      const globalData = await searchHTTP(globalArgs);
      const result = await pi("mem_search", args);
      t.diagnostic(`Pi global combination: ${JSON.stringify({ input: args, isError: result.isError ?? false, data: result.details?.data })}`);
      assert.notEqual(result.isError, true);
      assert.deepEqual(result.details.data, globalData, "Pi omits project when forwarding all_projects; complete unqualified HTTP payload");
      identity(result.details.data, [...ids.values()]);
      const mcp = envelope(await rpc("mem_search", args), true);
      identity(mcp.results, [...ids.values()]);
      if (response_format) assert.deepEqual(mcp.results, globalData);
    }
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_URL; else process.env.ENGRAM_URL = previous;
    if (url) await fetch(`${url}/stop`, { method: "POST" });
    assert.equal(await exited, 0, output);
  }
});
