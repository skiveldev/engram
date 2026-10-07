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

// Public runner evidence, not SDK validation or whole-host lifecycle parity.
test("doctor public reports and rejected checks preserve stored records and counters", async () => {
  const dir = mkdtempSync(join(scratch, "doctor-"));
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
      assert.ok(Array.isArray(exported.sessions));
      assert.ok(exported.sessions.some((entry) => entry.id === "doctor-parity" && entry.project === "parity"));
      assert.equal(typeof exported.exported_at, "string");
      assert.ok(Number.isFinite(Date.parse(exported.exported_at)));
      const { exported_at, ...stored } = exported;
      return { stored, stats: await http("/stats?all_projects=true") };
    };
    const read = async (label, operation) => {
      const before = await snapshot();
      try { return await operation(); }
      finally { assert.deepEqual(await snapshot(), before, `${label}: stored records and counters unchanged`); }
    };
    await http("/sessions", "POST", { id: "doctor-parity", project: "parity", registration_mode: "project_owned" }, 201);
    const tools = new Map();
    const sandbox = await createPluginSandbox(mkdtempSync(join(scratch, "doctor-pi-")));
    (await importPluginFromSandbox(sandbox))({ registerTool: (tool) => tools.set(tool.name, tool), on() {}, appendEntry() {} });
    const ctx = { cwd: dir, sessionManager: { getSessionId: () => "doctor-host" }, ui: { setStatus() {} } };
    const codes = ["ambiguous_active_runtime_sessions", "invalid_session_identity", "manual_session_name_project_mismatch",
      "orphaned_observation_session", "orphaned_pending_relations", "session_project_directory_mismatch",
      "sqlite_lock_contention", "sync_mutation_required_fields", "sync_target_closed_space", "unowned_session_project"];
    const comparable = (report) => ({ ...report, checks: report.checks.map((check) => {
      if (check.check_id !== "sqlite_lock_contention") return check;
      // A passive checkpoint may change physical WAL counters, not stored records.
      const evidence = { ...check.evidence };
      for (const key of ["checkpoint_log", "checkpointed_frames"]) {
        assert.ok(Number.isInteger(evidence[key]), `SQLite ${key}: ${JSON.stringify(evidence)}`);
        delete evidence[key];
      }
      return { ...check, evidence };
    }) });
    for (const check of ["orphaned_pending_relations", undefined, "unknown_contract_check"]) {
      const args = { project: "parity", ...(check ? { check } : {}) };
      const query = new URLSearchParams(args);
      const report = await read("HTTP doctor", () => http(`/doctor?${query}`));
      const rpc = await read("MCP doctor", () => http("/mcp", "POST", {
        jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mem_doctor", arguments: args },
      }));
      assert.equal(rpc.error, undefined, JSON.stringify(rpc));
      assert.equal(rpc.result.content.length, 1);
      assert.equal(rpc.result.content[0].type, "text");
      const mcp = JSON.parse(rpc.result.content[0].text);
      const pi = await read("Pi doctor", () => tools.get("mem_doctor").execute("paired", args, undefined, undefined, ctx));
      assert.deepEqual(comparable(mcp), comparable(report), "complete shared MCP report except validated WAL counters");
      assert.deepEqual(comparable(pi.details.data), comparable(report), "complete shared Pi report except validated WAL counters");
      assert.deepEqual(pi.content, [{ type: "text", text: JSON.stringify(pi.details.data, null, 2) }]);
      assert.equal(report.project, "parity");
      if (check === "unknown_contract_check") {
        assert.equal(report.status, "error");
        assert.deepEqual(report.summary, { total: 1, ok: 0, warnings: 0, blocked: 0, errors: 1 });
        assert.equal(rpc.result.isError, true);
        assert.equal(pi.isError, true);
        assert.equal(report.checks.length, 1);
        assert.deepEqual(report.checks[0], {
          check_id: "invalid_check", result: "error", severity: "error", reason_code: "invalid_check",
          message: 'invalid diagnostic check: "unknown_contract_check"',
          why: "Doctor could not run the requested diagnostic safely.",
          evidence: { error: 'invalid diagnostic check: "unknown_contract_check"' },
          safe_next_step: "Run `engram doctor` without --check to list registered diagnostics.", requires_confirmation: false,
        });
      } else {
        const expected = check ? [check] : codes;
        assert.equal(report.status, "ok");
        assert.deepEqual(report.summary, { total: expected.length, ok: expected.length, warnings: 0, blocked: 0, errors: 0 });
        assert.deepEqual(report.checks.map((entry) => entry.check_id), expected);
        assert.notEqual(rpc.result.isError, true);
        assert.notEqual(pi.isError, true);
        for (const entry of report.checks) {
          assert.equal(entry.result, "ok");
          assert.equal(entry.severity, "info");
          assert.equal(entry.reason_code, `${entry.check_id}_ok`);
          assert.equal(entry.message, "No issues detected.");
          assert.equal(entry.requires_confirmation, false);
          assert.equal(entry.findings, undefined);
        }
        const relations = report.checks.find((entry) => entry.check_id === "orphaned_pending_relations");
        assert.deepEqual(relations.evidence, { candidate_count: 0, one_endpoint_missing: 0, live_pending: 0 });
      }
    }
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_URL; else process.env.ENGRAM_URL = previous;
    if (url) await fetch(`${url}/stop`, { method: "POST" });
    assert.equal(await exited, 0, output);
  }
});
