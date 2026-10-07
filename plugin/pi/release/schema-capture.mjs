// A JSON-schema projection plus explicit recognized TypeBox metadata, not host validation.
export function capturePiSchema(schema) {
  const schemaMetadata = [];
  const ancestors = new Set();
  const fail = () => { throw new TypeError("unsupported Pi schema"); };
  function walk(value, path) {
    if (path.length > 128) return fail();
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0)) return fail();
      return value;
    }
    if (typeof value !== "object" || ancestors.has(value)) return fail();
    const array = Array.isArray(value);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== "string")) return fail();
    const dataKeys = array ? keys.filter(key => key !== "length") : keys.sort();
    if (array && (dataKeys.length !== value.length || dataKeys.some((key, i) => key !== String(i)))) return fail();
    ancestors.add(value);
    try {
      const output = array ? [] : {};
      for (const key of dataKeys) {
        const field = descriptors[key];
        if (!Object.hasOwn(field, "value")) return fail();
        if (!array && ["~kind", "~optional"].includes(key)) {
          if (key === "~kind" ? typeof field.value !== "string" || !field.value : field.value !== true) return fail();
          schemaMetadata.push({ path: [...path], key, value: field.value,
            enumerable: field.enumerable, configurable: field.configurable, writable: field.writable });
          continue;
        }
        if (!field.enumerable) return fail();
        const captured = walk(field.value, [...path, key]);
        // defineProperty also preserves a literal __proto__ JSON key safely.
        Object.defineProperty(output, key, { value: captured, enumerable: true, writable: true, configurable: true });
      }
      return output;
    } finally {
      ancestors.delete(value);
    }
  }
  const inputSchema = walk(schema, []);
  if (!inputSchema || Array.isArray(inputSchema) || inputSchema.type !== "object") return fail();
  schemaMetadata.sort((a, b) => a.path.length - b.path.length ||
    (JSON.stringify(a.path) < JSON.stringify(b.path) ? -1 : JSON.stringify(a.path) > JSON.stringify(b.path) ? 1 : 0) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { inputSchema, schemaMetadata };
}
