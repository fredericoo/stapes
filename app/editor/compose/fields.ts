import type * as v from "valibot";
import type { FieldMeta, TileKind } from "./field";

export type Field =
  | { kind: "tile"; tiles: TileKind }
  | { kind: "tiles"; tiles: TileKind }
  | { kind: "weighted"; tiles: TileKind }
  | { kind: "point"; level: boolean }
  | { kind: "points" }
  | { kind: "node" }
  | { kind: "direction" }
  | { kind: "percent" }
  | { kind: "placement"; tileProp: string }
  | { kind: "number"; min?: number; max?: number; integer: boolean }
  | { kind: "string" }
  | { kind: "boolean" }
  | { kind: "enum"; options: string[] }
  | { kind: "nullable"; inner: Field }
  | { kind: "unknown" };

export type FieldEntry = { name: string; field: Field; fallback: unknown };

type Introspected = {
  type: string;
  wrapped?: Introspected;
  default?: unknown;
  entries?: Record<string, Introspected>;
  options?: unknown[];
  pipe?: Array<{ type: string; requirement?: unknown; metadata?: unknown }>;
};

function requirement(schema: Introspected, type: string): number | undefined {
  const action = schema.pipe?.find((a) => a.type === type);
  return typeof action?.requirement === "number" ? action.requirement : undefined;
}

function fromMeta(meta: FieldMeta): Field {
  if (meta.field === "point") return { kind: "point", level: meta.level };
  if (meta.field === "points" || meta.field === "node") return { kind: meta.field };
  if (meta.field === "direction" || meta.field === "percent") return { kind: meta.field };
  if (meta.field === "placement") return { kind: "placement", tileProp: meta.tileProp };
  return { kind: meta.field, tiles: meta.tiles };
}

/**
 * Reads the form a valibot schema asks for from the schema object itself. A
 * prop built with `field.*` names its widget in its `v.metadata`; any other
 * prop gets one from its `type` and the actions in its pipe. Valibot keeps all
 * of that on the schema at runtime, which is what lets a component's schema
 * be the only description of its form.
 */
export function fieldOf(schema: Introspected): Field {
  if (schema.type === "optional") return fieldOf(schema.wrapped!);
  if (schema.type === "nullable") return { kind: "nullable", inner: fieldOf(schema.wrapped!) };
  const meta = schema.pipe?.find((a) => a.type === "metadata")?.metadata as FieldMeta | undefined;
  if (meta?.field) return fromMeta(meta);
  switch (schema.type) {
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
