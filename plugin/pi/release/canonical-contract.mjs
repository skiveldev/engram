import { createHash } from "node:crypto";

export const PROFILE_AGENT = Object.freeze([
  "mem_save", "mem_search", "mem_context", "mem_session_summary", "mem_session_start",
  "mem_session_end", "mem_get_observation", "mem_suggest_topic_key", "mem_capture_passive",
  "mem_save_prompt", "mem_update", "mem_current_project", "mem_list_projects", "mem_judge",
  "mem_compare", "mem_doctor", "mem_review", "mem_pin", "mem_unpin",
]);
export const PI_EXTRAS = Object.freeze(["mem_delete", "mem_stats", "mem_timeline"]);
const invalid = () => { throw new TypeError("invalid contract evidence"); };
const object = x => x !== null && typeof x === "object" && !Array.isArray(x);

// Reject rather than silently erase unsupported values, accessors or symbol metadata.
function encode(value, ancestors = new Set(), depth = 0) {
  if (depth > 128) return invalid();
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) return invalid();
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || ancestors.has(value)) return invalid();
  const array = Array.isArray(value);
  if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== "string")) return invalid();
  const dataKeys = array ? keys.filter(key => key !== "length") : keys;
  for (const key of dataKeys) {
    if (!descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value")) return invalid();
  }
  if (array && (dataKeys.length !== value.length || dataKeys.some((key, i) => key !== String(i)))) return invalid();
  ancestors.add(value);
  try {
    if (array) return `[${dataKeys.map(key => encode(descriptors[key].value, ancestors, depth + 1)).join(",")}]`;
    return `{${dataKeys.sort().map(key => `${JSON.stringify(key)}:${encode(descriptors[key].value, ancestors, depth + 1)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function inventory(tools, expected) {
  if (!Array.isArray(tools) || tools.length !== expected.length) return invalid();
  const names = new Set();
  for (const tool of tools) {
    if (!object(tool) || !expected.includes(tool.name) || names.has(tool.name) ||
      !object(tool.inputSchema) || tool.inputSchema.type !== "object") return invalid();
    names.add(tool.name);
  }
  return tools.toSorted((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/**
 * Produce UTF-8 canonical JSON bytes with one LF, and their SHA-256.
 * Capture/provenance validation belongs to the caller, never this pure encoder.
 * Tool records and explicit variant data retain all supplied JSON fields.
 */
export function canonicalContract(evidence) {
  // Validate lossless data before reading fields; never execute an accessor.
  const data = JSON.parse(encode(evidence));
  if (!object(data) || Object.keys(data).sort().join(",") !== "mcp,pi,variants" ||
    !object(data.variants) || data.variants.schema !== "engram.accepted-variants/v1" ||
    !object(data.variants.dispositions) || Object.keys(data.variants.dispositions).length === 0) return invalid();
  const manifest = {
    schema: "engram.canonical-contract/v1",
    mcp: inventory(data.mcp, PROFILE_AGENT),
    pi: inventory(data.pi, [...PROFILE_AGENT, ...PI_EXTRAS]),
    variants: data.variants,
  };
  const bytes = Buffer.from(`${encode(manifest)}\n`, "utf8");
  return { bytes, digest: createHash("sha256").update(bytes).digest("hex") };
}
