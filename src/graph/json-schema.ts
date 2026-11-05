import { Ajv } from "ajv";

const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 10_000;
const MAX_SCHEMA_ERRORS = 20;

// Match Jive's extractor contract: Ajv's default Draft-07 vocabulary, all
// validation errors, and non-strict handling of annotations/extension keys.
// This is the same configuration used by the upstream Jive plugin registry.
const ajv = new Ajv({ allErrors: true, strict: false });

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaBounds(schemaValue: unknown): string | undefined {
  let serialized: string;
  try {
    const encoded = JSON.stringify(schemaValue);
    if (typeof encoded !== "string") return "schema is not JSON-serializable";
    serialized = encoded;
  } catch {
    return "schema is not JSON-serializable";
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_SCHEMA_BYTES) {
    return `schema exceeds ${MAX_SCHEMA_BYTES} bytes`;
  }

  const stack: Array<{ value: unknown; depth: number }> = [{ value: schemaValue, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > MAX_SCHEMA_NODES) return `schema exceeds ${MAX_SCHEMA_NODES} nodes`;
    if (current.depth > MAX_SCHEMA_DEPTH) return `schema exceeds nesting limit ${MAX_SCHEMA_DEPTH}`;
    if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
    } else if (object(current.value)) {
      for (const child of Object.values(current.value)) stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return undefined;
}

/** Validate with the same Draft-07 Ajv semantics as Jive's extractor registry. */
export function validateExtractorSchema(value: unknown, schemaValue: unknown, label: string): string[] {
  if (!object(schemaValue)) return [`${label} schema must be a JSON object`];
  const boundsError = schemaBounds(schemaValue);
  if (boundsError !== undefined) return [`${label} ${boundsError}`];

  try {
    const validator = ajv.compile(schemaValue);
    if (validator(value)) return [];
    return (validator.errors ?? []).slice(0, MAX_SCHEMA_ERRORS).map((error) => {
      const path = error.instancePath === "" ? label : `${label}${error.instancePath}`;
      return `${path} ${error.message ?? "does not match schema"}`;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON Schema";
    return [`${label} schema is invalid: ${message.slice(0, 300)}`];
  }
}

export function isExtractorJsonSchema(value: unknown): value is Record<string, unknown> {
  if (!object(value)) return false;
  return schemaBounds(value) === undefined;
}
