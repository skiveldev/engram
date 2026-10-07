import assert from "node:assert/strict";
import { test } from "node:test";
import { capturePiSchema } from "../release/schema-capture.mjs";

function schema() {
  const optional = { type: "string", description: "kept" };
  Object.defineProperty(optional, "~kind", { value: "String", configurable: true });
  Object.defineProperty(optional, "~optional", { value: true, configurable: true });
  const value = { type: "object", properties: { optional }, required: [] };
  Object.defineProperty(value, "~kind", { value: "Object", configurable: true });
  return value;
}

test("capture keeps JSON constraints and explicit hidden metadata without modifying schemas", () => {
  const value = schema();
  const before = Object.getOwnPropertyDescriptors(value.properties.optional);
  assert.deepEqual(capturePiSchema(value), {
    inputSchema: { type: "object", properties: { optional: { type: "string", description: "kept" } }, required: [] },
    schemaMetadata: [
      { path: [], key: "~kind", value: "Object", enumerable: false, configurable: true, writable: false },
      { path: ["properties", "optional"], key: "~kind", value: "String", enumerable: false, configurable: true, writable: false },
      { path: ["properties", "optional"], key: "~optional", value: true, enumerable: false, configurable: true, writable: false },
    ],
  });
  assert.deepEqual(Object.getOwnPropertyDescriptors(value.properties.optional), before);
});

test("metadata order is independent of property insertion; nested array order remains intact", () => {
  const left = { type: "object", properties: { b: schema(), a: schema() }, enum: ["a", "b"] };
  const right = { enum: ["a", "b"], properties: { a: schema(), b: schema() }, type: "object" };
  assert.deepEqual(capturePiSchema(left), capturePiSchema(right));
  assert.deepEqual(capturePiSchema(left).inputSchema.enum, ["a", "b"]);
});

test("unknown hidden fields, symbols, accessors and cycles fail closed without executing getters", () => {
  for (const key of ["hidden", Symbol("kind"), "~unknown"]) {
    const value = schema(); Object.defineProperty(value, key, { value: "bad" });
    assert.throws(() => capturePiSchema(value), /unsupported Pi schema/);
  }
  let calls = 0;
  const value = schema(); Object.defineProperty(value, "getter", { enumerable: true, get() { calls++; } });
  assert.throws(() => capturePiSchema(value), /unsupported Pi schema/);
  assert.equal(calls, 0);
  const cycle = schema(); cycle.self = cycle;
  assert.throws(() => capturePiSchema(cycle), /unsupported Pi schema/);
});

test("invalid metadata, non-JSON values and array metadata are rejected", () => {
  for (const bad of [undefined, NaN, Infinity, -0, 1n, () => {}, new Date(), new Array(2)]) {
    const value = schema(); value.bad = bad;
    assert.throws(() => capturePiSchema(value), /unsupported Pi schema/);
  }
  for (const [key, bad] of [["~kind", 1], ["~optional", "true"]]) {
    const value = { type: "object" }; Object.defineProperty(value, key, { value: bad });
    assert.throws(() => capturePiSchema(value), /unsupported Pi schema/);
  }
  const value = schema(); value.required.extra = "invalid";
  assert.throws(() => capturePiSchema(value), /unsupported Pi schema/);
});
