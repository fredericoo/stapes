import type * as v from "valibot";

export type Field =
  | { kind: "number"; min?: number; max?: number; integer: boolean }
  | { kind: "string" }
  | { kind: "tileId" }
  | { kind: "tileList" }
  | { kind: "boolean" }
  | { kind: "enum"; options: string[] }
  | { kind: "point" }
  | { kind: "nullable"; inner: Field }
  | { kind: "unknown" };

export type FieldEntry = { name: string; field: Field; fallback: unknown };

type Introspected = {
  type: string;
  wrapped?: Introspected;
  default?: unknown;
  entries?: Record<string, Introspected>;
  options?: unknown[];
  item?: Introspected;
  pipe?: Array<{ type: string; requirement?: unknown; metadata?: { field?: string } }>;
};

function marked(schema: Introspected): string | undefined {
  return schema.pipe?.find((a) => a.type === "metadata")?.metadata?.field;
}

function requirement(schema: Introspected, type: string): number | undefined {
  const action = schema.pipe?.find((a) => a.type === type);
  return typeof action?.requirement === "number" ? action.requirement : undefined;
}

/**
 * Reads the form a valibot schema asks for from the schema object itself:
 * its `type`, the actions in its `pipe`, and the `field` its `v.metadata`
 * names. Valibot keeps all of that on the schema at runtime, which is what
 * lets a component's schema be the only description of its form.
 */
export function fieldOf(schema: Introspected): Field {
  const mark = marked(schema);
  if (mark === "tileId") return { kind: "tileId" };
  if (mark === "point") return { kind: "point" };
  switch (schema.type) {
    case "optional":
      return fieldOf(schema.wrapped!);
    case "nullable":
      return { kind: "nullable", inner: fieldOf(schema.wrapped!) };
    case "number":
      return {
        kind: "number",
        min: requirement(schema, "min_value"),
        max: requirement(schema, "max_value"),
        integer: schema.pipe?.some((a) => a.type === "integer") ?? false,
      };
    case "string":
      return { kind: "string" };
    case "boolean":
      return { kind: "boolean" };
    case "picklist":
      return { kind: "enum", options: (schema.options ?? []).map(String) };
    case "array":
      return schema.item && marked(schema.item) === "tileId"
        ? { kind: "tileList" }
        : { kind: "unknown" };
    default:
      return { kind: "unknown" };
  }
}

function fallbackOf(schema: Introspected): unknown {
  if (schema.type !== "optional") return undefined;
  return typeof schema.default === "function"
    ? (schema.default as () => unknown)()
    : schema.default;
}

export function fieldsOf(schema: v.GenericSchema): FieldEntry[] {
  const object = schema as unknown as Introspected;
  if (object.type !== "object" || !object.entries) return [];
  return Object.entries(object.entries).map(([name, entry]) => ({
    name,
    field: fieldOf(entry),
    fallback: fallbackOf(entry),
  }));
}
