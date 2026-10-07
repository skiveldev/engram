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

// Registered execution proves public core effects, not SDK argument validation.
test("pin and unpin change only local pin metadata across public transports", async () => {
  const dir = mkdtempSync(join(scratch, "pin-"));
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
    const snapshot = async () => {
      const exported = await http("/export?all_projects=true");
      assert.equal(typeof exported.exported_at, "string");
      assert.ok(Number.isFinite(Date.parse(exported.exported_at)));
      const { exported_at, ...stored } = exported;
      return { stored, stats: await http("/stats?all_projects=true") };
    };
    const unchanged = async (label, operation) => {
      const before = await snapshot();
      try { return await operation(); }
      finally { assert.deepEqual(await snapshot(), before, `${label}: every exported stored field and counter unchanged`); }
    };
    const rpc = async (name, args) => {
      const envelope = await http("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      assert.equal(envelope.error, undefined, JSON.stringify(envelope));
      return envelope.result;
    };
    const data = (result) => {
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(result.content.length, 1);
      assert.equal(result.content[0].type, "text");
      return JSON.parse(result.content[0].text);
    };
    const tools = new Map();
    const sandbox = await createPluginSandbox(mkdtempSync(join(scratch, "pin-pi-")));
    (await importPluginFromSandbox(sandbox))({ registerTool: (tool) => tools.set(tool.name, tool), on() {}, appendEntry() {} });
    const ctx = { cwd: dir, sessionManager: { getSessionId: () => "pin-host" }, ui: { setStatus() {} } };
    const pi = (name, args) => tools.get(name).execute("paired", args, undefined, undefined, ctx);
    await http("/sessions", "POST", { id: "pin-parity", project: "parity" }, 201);
    const marker = "pincontractuniquemarker";
    const saved = await http("/observations", "POST", { session_id: "pin-parity", project: "parity", type: "note",
      title: marker, content: `${marker} content`, scope: "project" }, 201);
    assert.equal(saved.status, "saved");
    const id = saved.id;
    assert.ok(Number.isSafeInteger(id) && id > 0);
    const initial = await snapshot();
    const observation = initial.stored.observations.find((entry) => entry.id === id);
    assert.ok(observation);
    assert.equal(observation.pinned, false);
    const baselineSearch = await unchanged("baseline compact search", () => http(`/search?q=${marker}&project=parity&response_format=compact`));
    assert.deepEqual(baselineSearch.map((entry) => entry.id), [id]);
    const effects = async (pinned) => {
      const expected = baselineSearch.map((entry) => ({ ...entry, pinned }));
      const search = await unchanged("HTTP compact search", () => http(`/search?q=${marker}&project=parity&response_format=compact`));
      assert.deepEqual(search, expected, "complete search records/order differ only in pinned");
      const mcp = data(await unchanged("MCP compact search", () => rpc("mem_search", { query: marker, project: "parity", response_format: "compact" })));
      assert.deepEqual(mcp.results, search);
      const piSearch = await unchanged("Pi compact search", () => pi("mem_search", { query: marker, project: "parity", response_format: "compact" }));
      assert.notEqual(piSearch.isError, true);
      assert.deepEqual(piSearch.details.data, search);
      const context = await unchanged("HTTP context", () => http("/context?project=parity"));
      const piContext = await unchanged("Pi context", () => pi("mem_context", { project: "parity" }));
      assert.notEqual(piContext.isError, true);
      assert.deepEqual(piContext.details.data, context);
      const mcpContext = data(await unchanged("MCP context", () => rpc("mem_context", { project: "parity" })));
      for (const text of [context.context, mcpContext.result]) {
        const section = pinned ? "### Pinned" : "### Recent Observations";
        assert.equal(typeof text, "string");
        assert.ok(text.includes(section), text);
        const body = text.slice(text.indexOf(section) + section.length).split("\n### ")[0];
        assert.ok(body.includes(marker), `target occurs in ${section}: ${text}`);
        if (!pinned) assert.equal(text.includes("### Pinned"), false, text);
      }
    };
    const mutation = async (transport, pinned, input = id) => {
      const before = await snapshot();
      const expected = structuredClone(before);
      expected.stored.observations.find((entry) => entry.id === id).pinned = pinned;
      const name = pinned ? "mem_pin" : "mem_unpin";
      if (transport === "HTTP") {
        assert.deepEqual(await http(`/observations/${input}/pin`, pinned ? "PUT" : "DELETE"), { id, pinned });
      } else if (transport === "MCP") {
        assert.deepEqual(data(await rpc(name, { id: input })), { id, pinned, sync_id: observation.sync_id,
          result: `Memory #${id} ${pinned ? "pinned" : "unpinned"}` });
      } else {
        const result = await pi(name, { id: input });
        assert.notEqual(result.isError, true);
        assert.deepEqual(result.details.data, { id, pinned });
        assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify({ id, pinned }, null, 2) }]);
      }
      assert.deepEqual(await snapshot(), expected, `${transport} ${name}: exactly pinned changes, repeat calls preserve everything`);
      await effects(pinned);
    };
    for (const transport of ["HTTP", "MCP", "Pi"]) {
      for (const pinned of [true, true, false, false]) await mutation(transport, pinned);
    }
    // MCP truncates fractional numeric IDs; Pi forwards the fraction to HTTP.
    await mutation("MCP", true, id + 0.5);
    await mutation("MCP", false, id + 0.5);
    const rejectHTTP = async (input, pinned, status, error) => unchanged("rejected HTTP pin", async () => {
      const response = await fetch(`${url}/observations/${input}/pin`, { method: pinned ? "PUT" : "DELETE" });
      assert.equal(response.status, status);
      assert.equal(response.headers.get("content-type"), "application/json");
      assert.equal(await response.text(), `${JSON.stringify({ error })}\n`);
    });
    const missing = id + 1000000;
    for (const pinned of [true, false]) {
      const name = pinned ? "mem_pin" : "mem_unpin";
      for (const input of ["not-an-id", 0, -1, id + 0.5]) await rejectHTTP(input, pinned, 400, "invalid observation id");
      await rejectHTTP(missing, pinned, 404, "observation not found");
      for (const [input, status, error] of [[0, 400, "invalid observation id"], [-1, 400, "invalid observation id"],
        [id + 0.5, 400, "invalid observation id"], [missing, 404, "observation not found"]]) {
        const result = await unchanged("rejected Pi pin", () => pi(name, { id: input }));
        assert.equal(result.isError, true);
        assert.deepEqual(result.content, [{ type: "text", text: error }]);
        assert.deepEqual(result.details, { error, http_status: status, data: { error } });
      }
      for (const [args, error] of [[{}, "id is required"], [{ id: 0 }, "id is required"],
        [{ id: -1 }, "Failed to update pin state: observation not found"], [{ id: missing }, "Failed to update pin state: observation not found"]]) {
        const result = await unchanged("rejected MCP pin", () => rpc(name, args));
        assert.equal(result.isError, true);
        assert.deepEqual(result.content, [{ type: "text", text: error }]);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_URL; else process.env.ENGRAM_URL = previous;
    if (url) await fetch(`${url}/stop`, { method: "POST" });
    assert.equal(await exited, 0, output);
  }
});
