import { canonicalContract } from "./canonical-contract.mjs";

// Recorded T2 dispositions, not a claim that MCP and Pi behave identically.
const dispositions = Object.freeze({
  mem_search: "With project and all_projects together, HTTP rejects with 400; Pi omits project and succeeds globally; MCP resolves globally. This accepted behavior applies to default and compact responses.",
  mem_update: "For a missing observation ID, MCP reports Failed to update memory: sql: no rows in result set; HTTP and Pi retain their separately tested error responses. Error-text parity is not claimed.",
  mem_list_projects: "Complete project records and counts are compared independently of ordering. Raw transport-order parity is not claimed; no stable ordering contract is asserted.",
  mem_save: "MCP accepts session_id/recovery_token/project_choice_reason; Pi owns its session and accepts cwd.",
  mem_save_prompt: "MCP accepts session_id/recovery_token/project_choice_reason; Pi owns its session and accepts cwd. With a different resolved owner and target project, Pi creates a satellite session and prompt, changing both session and prompt counters. These public effects are tested separately; host lifecycle parity is not claimed.",
  mem_session_summary: "MCP accepts session_id/recovery_token/project_choice_reason; Pi owns its session and accepts cwd. MCP title is Session summary: <project>; Pi title is Session summary. First Pi rejection can register a satellite session.",
  mem_capture_passive: "MCP accepts session_id; Pi owns its session. Default source is mcp-passive versus pi-tool. First Pi registration effects are separate from capture effects.",
  mem_current_project: "Pi accepts cwd; MCP resolves in its server context.",
  mem_context: "MCP max_bytes is number with fractional/nonpositive fallback; Pi schema is integer minimum 1. SDK fractional coercion and nonpositive rejection are tested separately.",
  mem_get_observation: "MCP project supplies response context, not ownership filtering; Pi has no project argument. MCP history_cursor is number; Pi is integer minimum 0.",
  mem_suggest_topic_key: "Pi retains its local slug and blank-input fallback; MCP core output and rejection differ. Suggestions are not equivalent.",
  mem_session_start: "MCP resolves project independently of any supplied project field. Pi attribution, leases, continuation and recovery are host-owned.",
  mem_session_end: "MCP resolves project independently of any supplied project field; Pi accepts only its current host identity. Completion is not host recovery parity.",
});
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const validSource = value => value && typeof value === "object" && !Array.isArray(value) &&
  typeof value.commit === "string" && typeof value.tree === "string" &&
  objectId.test(value.commit) && objectId.test(value.tree);

/** Producer validates runtime sources against Git; this consumer compares identities.
 * A matching supplied identity is not a signature, receipt, or provenance proof.
 */
export function buildContractManifest(capture, expectedSource) {
  if (!validSource(expectedSource) || capture?.schema !== "engram.schema-capture/v2" ||
    !validSource(capture.source) || capture.source.commit !== expectedSource.commit ||
    capture.source.tree !== expectedSource.tree) throw new TypeError("invalid capture binding");
  const { bytes, digest } = canonicalContract({ mcp: capture.mcp, pi: capture.pi,
    variants: { schema: "engram.accepted-variants/v1", dispositions } });
  return { source: { commit: capture.source.commit, tree: capture.source.tree }, bytes, contractDigest: digest };
}
