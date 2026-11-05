import { describe, expect, it } from "vitest";
import { isExtractorJsonSchema, validateExtractorSchema } from "../../src/graph/json-schema.js";

describe("extractor JSON Schema validation", () => {
  it("matches Jive Ajv Draft-07 behavior for nested structures and scalar constraints", () => {
    const schema = {
      type: "object",
      required: ["records"],
      additionalProperties: false,
      properties: {
        records: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "integer", minimum: 1 } },
          },
        },
      },
    };
    expect(validateExtractorSchema({ records: [{ id: 1 }] }, schema, "output")).toEqual([]);
    expect(validateExtractorSchema({ records: [{ id: 0 }] }, schema, "output")).toContain("output/records/0/id must be >= 1");
    expect(validateExtractorSchema({ records: [] }, schema, "output")).toContain("output/records must NOT have fewer than 1 items");
  });

  it("supports Jive's standard pattern and composition keywords", () => {
    const schema = {
      type: "object",
      required: ["name", "kind"],
      properties: {
        name: { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" },
        kind: { enum: ["file", "directory"] },
        size: { type: "integer", minimum: 0 },
      },
      allOf: [{
        if: { properties: { kind: { const: "directory" } }, required: ["kind"] },
        then: { not: { required: ["size"] } },
      }],
    };
    expect(validateExtractorSchema({ name: "src-1", kind: "file", size: 12 }, schema, "input")).toEqual([]);
    expect(validateExtractorSchema({ name: "Bad Name", kind: "file" }, schema, "input")[0]).toContain("input/name must match pattern");
    expect(validateExtractorSchema({ name: "src", kind: "directory", size: 12 }, schema, "input")).toContain("input must NOT be valid");
  });

  it("uses the upstream non-strict behavior for annotation and extension keywords", () => {
    expect(isExtractorJsonSchema({ type: "string", examples: ["x"], "x-vendor-note": true })).toBe(true);
    expect(validateExtractorSchema("x", { type: "string", examples: ["x"], "x-vendor-note": true }, "input")).toEqual([]);
  });

  it("reports all property/type errors from a validation pass", () => {
    const errors = validateExtractorSchema(
      { name: 7, unexpected: true },
      { type: "object", additionalProperties: false, properties: { name: { type: "string" } } },
      "config",
    );
    expect(errors).toContain("config must NOT have additional properties");
    expect(errors).toContain("config/name must be string");
  });

  it("rejects oversized, deeply nested, and invalid schemas before they reach extractors", () => {
    expect(validateExtractorSchema("x", { type: "string", title: "x".repeat(70_000) }, "input")[0]).toContain("exceeds 65536 bytes");
    let deep: Record<string, unknown> = { type: "string" };
    for (let index = 0; index < 34; index += 1) deep = { properties: { nested: deep } };
    expect(validateExtractorSchema({}, deep, "input")[0]).toContain("exceeds nesting limit 32");
    expect(isExtractorJsonSchema({ items: Array.from({ length: 10_001 }, () => null) })).toBe(false);
    expect(validateExtractorSchema("x", { type: "not-a-json-schema-type" }, "input")[0]).toContain("schema is invalid");
  });

  it("caps returned validation details while still collecting multiple errors", () => {
    const properties = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`p${index}`, { type: "string" }]));
    const errors = validateExtractorSchema(
      Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`p${index}`, index])),
      { type: "object", properties },
      "output",
    );
    expect(errors).toHaveLength(20);
  });
});
