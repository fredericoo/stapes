import { IconCrosshair, IconX } from "@tabler/icons-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button, Input, NumberInput, Segmented, Select, Switch, Tooltip } from "../../ui";
import type { ComponentRegistry } from "./build";
import { PIN_X, PIN_Y, type Frame, type MapDoc, type MapNode, type Point } from "./doc";
import { allKeys, reframeNode, renameNode, updateNode } from "./edit";
import { fieldsOf, type Field } from "./fields";
import type { Bounds } from "../generator";
import { pointFor, pointFrame, type Layout, type Placement } from "./layout";
import { PlacementField } from "./PlacementField";
import { TilePicker, TileSet, WeightedTiles } from "./TilePicker";

const UINT32 = 4294967296;
const DEFAULT_FRAME_SPAN = 16;

/** The select's value for "this node's frame"; an empty string reads as no selection. */
const OWN_FRAME = "@own";

/** A prop's name as a label: `undergrowthDensity` reads as "undergrowth density". */
function spaced(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

/**
 * A row is a group rather than a `<label>`: a label names and clicks the
 * first control inside it, and a row can hold several (a point's frame,
 * offsets and pins), so each control carries its own `aria-label` instead.
 */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="grid grid-cols-[7.5rem_1fr] items-center gap-2 text-sm"
    >
      <span className="truncate text-muted">{label}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-1">{children}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b-2 border-border px-3 py-3">
      <h3 className="text-xs font-bold uppercase tracking-wide">{title}</h3>
      {children}
    </section>
  );
}

/** A text box that reports on Enter or blur, so the map is not rebuilt for every keystroke. */
function TextField({
  value,
  onCommit,
  ariaLabel,
}: {
  value: string;
  onCommit: (value: string) => void;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Input
      aria-label={ariaLabel}
      className="w-full min-w-0 shadow-none"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && draft !== value) onCommit(draft);
        if (e.key === "Escape") setDraft(value);
      }}
    />
  );
}

function Num({
  value,
  onChange,
  label,
  min,
  max,
  integer = true,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
  min?: number;
  max?: number;
  integer?: boolean;
}) {
  return (
    <NumberInput
      aria-label={label}
      className="w-20 shadow-none"
      value={value}
      min={min}
      max={max}
      step={integer ? 1 : undefined}
      onChange={onChange}
    />
  );
}

type Cell = { x: number; y: number };

/** Arms "pick on map": the next click on the map hands its cell to `apply` instead of selecting a layer. */
export type PickCell = (apply: (cell: Cell) => void) => void;

const COMPASS = [
  { value: "n", label: "N" },
  { value: "e", label: "E" },
  { value: "s", label: "S" },
  { value: "w", label: "W" },
] as const;

function PointEditor({
  point,
  onChange,
  keys,
  label,
  level,
  frameOf,
  pickCell,
}: {
  point: Point;
  onChange: (point: Point) => void;
  keys: string[];
  label: string;
  level: boolean;
  frameOf: (point: Point) => Bounds | null;
  pickCell: PickCell;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1">
        <Select
          ariaLabel={`${label}: measured in`}
          value={point.in ?? OWN_FRAME}
          onValueChange={(value) => {
            const { in: _in, ...rest } = point;
            onChange(value && value !== OWN_FRAME ? { ...rest, in: value } : rest);
          }}
          options={[
            { value: OWN_FRAME, label: "this node's frame" },
            ...keys.map((k) => ({ value: k, label: k })),
          ]}
        />
        <Tooltip content="Click the map to put it there">
          <Button
            size="icon"
            aria-label={`Pick ${label} on the map`}
            onClick={() =>
              pickCell((cell) => {
                const frame = frameOf(point);
                if (frame) onChange(pointFor(point, cell, frame));
              })
            }
          >
            <IconCrosshair size={16} aria-hidden="true" />
          </Button>
        </Tooltip>
      </span>
      <span className="flex items-center gap-1">
        <Num
          label={`${label} x`}
          integer={point.pinX !== "scale"}
          value={point.x}
          onChange={(x) => onChange({ ...point, x })}
        />
        <Select
          ariaLabel={`${label}: x from`}
          className="min-w-[5.5rem]"
          value={point.pinX ?? "left"}
          onValueChange={(pinX) => onChange({ ...point, pinX: pinX as Point["pinX"] })}
          options={PIN_X.map((p) => ({ value: p, label: p }))}
        />
      </span>
      <span className="flex items-center gap-1">
        <Num
          label={`${label} y`}
          integer={point.pinY !== "scale"}
          value={point.y}
          onChange={(y) => onChange({ ...point, y })}
        />
        <Select
          ariaLabel={`${label}: y from`}
          className="min-w-[5.5rem]"
          value={point.pinY ?? "top"}
          onValueChange={(pinY) => onChange({ ...point, pinY: pinY as Point["pinY"] })}
          options={PIN_Y.map((p) => ({ value: p, label: p }))}
        />
      </span>
      {level ? (
        <span className="flex items-center gap-1">
          <Num
            label={`${label} level`}
            value={point.z ?? 0}
            onChange={(z) => onChange({ ...point, z })}
          />
          <span className="text-xs text-muted">levels above this node</span>
        </span>
      ) : null}
    </div>
  );
}

function FieldEditor({
  field,
  value,
  fallback,
  onChange,
  keys,
  label,
  frameOf,
  pickCell,
  nodeProps,
}: {
  field: Field;
  value: unknown;
  fallback: unknown;
  onChange: (value: unknown) => void;
  keys: string[];
  label: string;
  frameOf: (point: Point) => Bounds | null;
  pickCell: PickCell;
  nodeProps: Record<string, unknown>;
}): ReactNode {
  switch (field.kind) {
    case "number":
      return (
        <Num
          label={label}
          value={typeof value === "number" ? value : 0}
          min={field.min}
          max={field.max}
          integer={field.integer}
          onChange={onChange}
        />
      );
    case "percent": {
      const n = typeof value === "number" ? value : 0;
      return (
        <span className="flex w-full items-center gap-2">
          <input
            type="range"
            aria-label={label}
            min={0}
            max={100}
            value={n}
            className="hard-slider min-w-0 flex-1"
            onChange={(e) => onChange(Number(e.target.value))}
          />
          <span className="w-10 text-right text-xs tabular-nums">{n}%</span>
        </span>
      );
    }
    case "direction":
      return (
        <Segmented
          ariaLabel={label}
          size="sm"
          value={String(value ?? "s")}
          options={COMPASS.map((c) => ({ value: c.value as string, label: c.label }))}
          onChange={onChange}
        />
      );
    case "string":
      return <TextField ariaLabel={label} value={String(value ?? "")} onCommit={onChange} />;
    case "tile":
      return (
        <TilePicker
          value={String(value ?? "")}
          kind={field.tiles}
          label={label}
          onChange={onChange}
        />
      );
    case "tiles":
      return (
        <TileSet
          value={Array.isArray(value) ? (value as string[]) : []}
          kind={field.tiles}
          label={label}
          onChange={onChange}
        />
      );
    case "weighted":
      return (
        <WeightedTiles
          value={Array.isArray(value) ? (value as Array<{ tile: string; weight: number }>) : []}
          kind={field.tiles}
          label={label}
          onChange={onChange}
        />
      );
    case "points": {
      const points = Array.isArray(value) ? (value as Point[]) : [];
      return (
        <span className="flex w-full flex-col gap-1">
          {points.length === 0 ? (
            <span className="text-xs text-muted">Straight from start to end</span>
          ) : null}
          {points.map((p, i) => (
            <span key={i} className="flex items-center gap-1 text-xs tabular-nums">
              <span className="w-5 text-muted">{i + 1}</span>
              <Num
                label={`${label} ${i + 1} x`}
                value={p.x}
                integer={p.pinX !== "scale"}
                onChange={(x) => onChange(points.map((q, j) => (j === i ? { ...q, x } : q)))}
              />
              <Num
                label={`${label} ${i + 1} y`}
                value={p.y}
                integer={p.pinY !== "scale"}
                onChange={(y) => onChange(points.map((q, j) => (j === i ? { ...q, y } : q)))}
              />
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Remove ${label} point ${i + 1}`}
                onClick={() => onChange(points.filter((_, j) => j !== i))}
              >
                <IconX size={14} aria-hidden="true" />
              </Button>
            </span>
          ))}
          <Button
            size="sm"
            onClick={() =>
              pickCell((cell) => {
                const frame = frameOf({ x: 0, y: 0 });
                if (frame) onChange([...points, pointFor({ x: 0, y: 0 }, cell, frame)]);
              })
            }
          >
            Add a point on the map
          </Button>
        </span>
      );
    }
    case "placement":
      return (
        <PlacementField
          tileId={String(nodeProps[field.tileProp] ?? "")}
          value={(value as Record<string, unknown> | undefined) ?? {}}
          onChange={onChange}
        />
      );
    case "boolean":
      return <Switch ariaLabel={label} checked={value === true} onCheckedChange={onChange} />;
    case "enum":
      return (
        <Select
          ariaLabel={label}
          value={String(value ?? field.options[0])}
          onValueChange={onChange}
          options={field.options.map((o) => ({ value: o, label: o }))}
        />
      );
    case "point":
      return (
        <PointEditor
          label={label}
          keys={keys}
          level={field.level}
          frameOf={frameOf}
          pickCell={pickCell}
          point={(value as Point | undefined) ?? { x: 0, y: 0 }}
          onChange={onChange}
        />
      );
    case "nullable":
      return (
        <>
          <Switch
            ariaLabel={`${label} on`}
            checked={value !== null}
            onCheckedChange={(on) => onChange(on ? (fallback ?? "") : null)}
          />
          {value !== null ? (
            <span className="min-w-0 flex-1">
              <FieldEditor
                field={field.inner}
                value={value}
                fallback={fallback}
                onChange={onChange}
                keys={keys}
                label={label}
                frameOf={frameOf}
                pickCell={pickCell}
                nodeProps={nodeProps}
              />
            </span>
          ) : null}
        </>
      );
    default:
      return <span className="text-xs text-muted">Edit this in the JSON</span>;
  }
}

/**
 * The selected node's own fields, then its frame, then its component's props
 * as its schema describes them. A prop the node does not set shows its
 * schema's default, and is written only once it is changed.
 */
export function Inspector({
  doc,
  node,
  placement,
  built,
  isRoot,
  components,
  problems,
  onChange,
  onRenamed,
  pickCell,
}: {
  doc: MapDoc;
  node: MapNode;
  placement: Placement | undefined;
  built: { layout: Layout; written: ReadonlyMap<string, Bounds> };
  isRoot: boolean;
  components: ComponentRegistry;
  problems: string[];
  onChange: (doc: MapDoc) => void;
  onRenamed: (key: string) => void;
  pickCell: PickCell;
}) {
  const component = components[node.type];
  const keys = allKeys(doc.root).filter((k) => k !== node.key);
  const update = (fn: (node: MapNode) => MapNode) => onChange(updateNode(doc, node.key, fn));
  const setFrame = (patch: Partial<Frame>) =>
    update((n) => ({ ...n, frame: { ...n.frame!, ...patch } }));
  const setProp = (name: string, value: unknown) =>
    update((n) => ({ ...n, props: { ...n.props, [name]: value } }));

  return (
    <div className="flex flex-col">
      {problems.length > 0 ? (
        <div className="border-b-2 border-border bg-danger px-3 py-2 text-sm text-paper">
          {problems.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      ) : null}
      <Section title={component?.label ?? node.type}>
        <Row label="key">
          <TextField
            ariaLabel="key"
            value={node.key}
            onCommit={(next) => {
              const key = next.trim();
              if (!key || keys.includes(key)) return;
              onChange(renameNode(doc, node.key, key));
              onRenamed(key);
            }}
          />
        </Row>
        <Row label="seed">
          <span className="text-sm tabular-nums">{placement?.seed ?? "—"}</span>
          <span className="text-xs text-muted">
            {node.seed === undefined ? "from key" : "pinned"}
          </span>
          <Button
            size="sm"
            onClick={() => update((n) => ({ ...n, seed: Math.floor(Math.random() * UINT32) }))}
          >
            Re-roll
          </Button>
          {node.seed !== undefined ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                update((n) => {
                  const { seed: _seed, ...rest } = n;
                  return rest;
                })
              }
            >
              Unpin
            </Button>
          ) : null}
        </Row>
        <Row label="hidden">
          <Switch
            ariaLabel="hidden"
            checked={node.hidden === true}
            onCheckedChange={(hidden) => update((n) => ({ ...n, hidden }))}
          />
        </Row>
      </Section>
      <Section title="Frame">
        {node.frame ? (
          <>
            <Row label="x, y">
              <Num label="x" value={node.frame.x} onChange={(x) => setFrame({ x })} />
              <Num label="y" value={node.frame.y} onChange={(y) => setFrame({ y })} />
            </Row>
            <Row label="width, height">
              <Num label="width" min={1} value={node.frame.w} onChange={(w) => setFrame({ w })} />
              <Num label="height" min={1} value={node.frame.h} onChange={(h) => setFrame({ h })} />
            </Row>
            <Row label="level">
              <Num label="level" value={node.frame.z ?? 0} onChange={(z) => setFrame({ z })} />
            </Row>
            {isRoot ? null : (
              <>
                <Row label="x from">
                  <Select
                    ariaLabel="x from"
                    value={node.frame.pinX ?? "left"}
                    onValueChange={(pinX) => setFrame({ pinX: pinX as Frame["pinX"] })}
                    options={PIN_X.map((p) => ({ value: p, label: p }))}
                  />
                </Row>
                <Row label="y from">
                  <Select
                    ariaLabel="y from"
                    value={node.frame.pinY ?? "top"}
                    onValueChange={(pinY) => setFrame({ pinY: pinY as Frame["pinY"] })}
                    options={PIN_Y.map((p) => ({ value: p, label: p }))}
                  />
                </Row>
                <Row label="absolute">
                  <Switch
                    ariaLabel="absolute"
                    checked={node.frame.absolute === true}
                    onCheckedChange={(absolute) => setFrame({ absolute })}
                  />
                </Row>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onChange(reframeNode(doc, built, node.key, null))}
                >
                  Fill the parent instead
                </Button>
              </>
            )}
          </>
        ) : (
          <>
            <p className="text-sm text-muted">Fills its parent.</p>
            <Button
              size="sm"
              onClick={() =>
                onChange(
                  reframeNode(
                    doc,
                    built,
                    node.key,
                    node.children?.some((c) => c.frame)
                      ? "fit"
                      : { x: 0, y: 0, w: DEFAULT_FRAME_SPAN, h: DEFAULT_FRAME_SPAN },
                  ),
                )
              }
            >
              {node.children?.some((c) => c.frame)
                ? "Frame round its children"
                : "Give it its own frame"}
            </Button>
          </>
        )}
      </Section>
      {component ? (
        <Section title="Props">
          {fieldsOf(component.schema).map(({ name, field, fallback }) => (
            <Row key={name} label={spaced(name)}>
              <FieldEditor
                field={field}
                label={name}
                keys={keys}
                fallback={fallback}
                value={node.props && name in node.props ? node.props[name] : fallback}
                onChange={(value) => setProp(name, value)}
                pickCell={pickCell}
                nodeProps={node.props ?? {}}
                frameOf={(point) => (placement ? pointFrame(built.layout, placement, point) : null)}
              />
            </Row>
          ))}
        </Section>
      ) : null}
    </div>
  );
}
