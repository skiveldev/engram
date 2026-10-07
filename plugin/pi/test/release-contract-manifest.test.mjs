import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { buildContractManifest } from "../release/contract-manifest.mjs";
import { PROFILE_AGENT, PI_EXTRAS } from "../release/canonical-contract.mjs";

// Synthetic binding tests do not constitute actual capture/provenance evidence.
const source = { commit: "a".repeat(40), tree: "b".repeat(40) };
function capture() {
  const tool = name => ({ name, inputSchema: { type: "object", properties: {} } });
  return { schema: "engram.schema-capture/v2", source: { ...source },
    mcp: PROFILE_AGENT.map(tool), pi: [...PROFILE_AGENT, ...PI_EXTRAS].map(tool) };
}
test("manifest preserves captured schemas and accepted variants, bound to the expected source", () => {
  const input = capture(), before = structuredClone(input);
  const result = buildContractManifest(input, source);
  assert.deepEqual(input, before);
  assert.deepEqual(result.source, source);
  assert.equal(result.contractDigest, createHash("sha256").update(result.bytes).digest("hex"));
  const manifest = JSON.parse(result.bytes);
  assert.deepEqual(manifest.mcp, input.mcp.toSorted((a, b) => a.name < b.name ? -1 : 1));
  for (const name of ["mem_save", "mem_save_prompt", "mem_session_summary", "mem_capture_passive",
    "mem_current_project", "mem_context", "mem_get_observation", "mem_suggest_topic_key", "mem_session_start", "mem_session_end"]) {
    assert.ok(manifest.variants.dispositions[name], name);
  }
  assert.match(manifest.variants.dispositions.mem_context, /fractional/);
  assert.match(manifest.variants.dispositions.mem_capture_passive, /mcp-passive.*pi-tool/);
  assert.equal(manifest.variants.schema, "engram.accepted-variants/v1");
});
test("manifest records the accepted project plus global search transport variant", () => {
  const { variants } = JSON.parse(buildContractManifest(capture(), source).bytes);
  assert.equal(variants.dispositions.mem_search,
    "With project and all_projects together, HTTP rejects with 400; Pi omits project and succeeds globally; MCP resolves globally. This accepted behavior applies to default and compact responses.");
});
test("manifest records the accepted missing-observation update error variant", () => {
  const { variants } = JSON.parse(buildContractManifest(capture(), source).bytes);
  assert.equal(variants.dispositions.mem_update,
    "For a missing observation ID, MCP reports Failed to update memory: sql: no rows in result set; HTTP and Pi retain their separately tested error responses. Error-text parity is not claimed.");
});
test("manifest limits project-list comparison to complete order-independent records", () => {
  const { variants } = JSON.parse(buildContractManifest(capture(), source).bytes);
  assert.equal(variants.dispositions.mem_list_projects,
    "Complete project records and counts are compared independently of ordering. Raw transport-order parity is not claimed; no stable ordering contract is asserted.");
});
test("manifest records the accepted prompt satellite effects without lifecycle parity", () => {
  const { variants } = JSON.parse(buildContractManifest(capture(), source).bytes);
  assert.equal(variants.dispositions.mem_save_prompt,
    "MCP accepts session_id/recovery_token/project_choice_reason; Pi owns its session and accepts cwd. With a different resolved owner and target project, Pi creates a satellite session and prompt, changing both session and prompt counters. These public effects are tested separately; host lifecycle parity is not claimed.");
});
test("unbound, malformed, legacy and mismatched captures fail closed", () => {
  for (const mutate of [x => { delete x.source; }, x => { x.source.commit = "c".repeat(40); },
    x => { x.source.tree = "d".repeat(40); }, x => { x.schema = "engram.schema-capture/v1"; },
    x => { x.source.commit += "\n"; }, x => { x.source.tree = "B".repeat(40); }]) {
    const value = capture(); mutate(value);
    assert.throws(() => buildContractManifest(value, source), /invalid capture binding/);
  }
  for (const expected of [undefined, {}, { ...source, commit: "short" }]) {
    assert.throws(() => buildContractManifest(capture(), expected), /invalid capture binding/);
  }
});
test("source identity is separate from contract bytes; schema and metadata changes affect digest", () => {
  const value = capture(), first = buildContractManifest(value, source);
  const other = { commit: "c".repeat(40), tree: "d".repeat(40) };
  value.source = other;
  assert.equal(buildContractManifest(value, other).contractDigest, first.contractDigest);
  value.pi[0].schemaMetadata = [{ path: [], key: "~kind", value: "Object", enumerable: false }];
  assert.notEqual(buildContractManifest(value, other).contractDigest, first.contractDigest);
  value.pi.pop();
  assert.throws(() => buildContractManifest(value, other), /invalid contract evidence/);
});
