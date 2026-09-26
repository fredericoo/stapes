import { useMemo, useState } from "react";
import { parseFormula, type FormulaScope } from "../lib/formula";
import {
  completeSprite,
  MAX_STATUS_DESCRIPTION_LENGTH,
  MAX_STATUS_DURATION_MS,
  MODIFIER_KEYS,
  resolveStatus,
  STATUS_TONES,
  type StatusSource,
} from "../lib/status";
import { MAX_WALK_SPEED_PERCENT, MIN_WALK_SPEED_PERCENT } from "../lib/walkSpeed";
import { snapToTick } from "../game/statuses";
import type { StatusVfx } from "../lib/statusVfx";
import {
  defaultBase,
  type AnchoredSprite,
  type SpriteRef,
  type TileDef,
  type TilesetDef,
} from "../lib/types";
import { Button, Dialog, FieldLabel, Input, NumberInput, Select, Switch } from "../ui";
import { SpritePreview } from "./TilePreview";
import { SpriteSelector } from "./SpriteSelector";
import { StatusVfxFields } from "./StatusVfxFields";
import { VfxPreview } from "./VfxPreview";
import { TITLE_SPRITE_SIZE_PX } from "./ContainerPanel";

const SAMPLE_SCOPE: FormulaScope = {
  DURATION_SEC: 30,
  REMAINING_SEC: 20,
  ELAPSED_SEC: 10,
  MAX_HP: 16,
  HP: 9,
  statuses: [],
};

function previewOf(source: string): { ok: boolean; text: string } {
  if (!source.trim()) return { ok: true, text: "—" };
  const formula = parseFormula(source);
  if (!formula) return { ok: false, text: "not a formula" };
  return { ok: true, text: `= ${formula.evaluate(SAMPLE_SCOPE)}` };
}

function FormulaField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const preview = previewOf(value);
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[11px] font-bold uppercase text-muted">{label}</span>
      <Input
        value={value}
        placeholder="blank for none"
        onChange={(e) => onChange(e.target.value)}
      />
      <span className={`text-[11px] ${preview.ok ? "text-muted" : "text-danger"}`}>
        {preview.text}
        {hint && preview.ok ? ` · ${hint}` : ""}
      </span>
    </label>
  );
}

function MsField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[11px] font-bold uppercase text-muted">{label}</span>
      <NumberInput
        min={0}
        max={MAX_STATUS_DURATION_MS}
        step={1}
        value={value}
        onChange={onChange}
      />
      {hint ? <span className="text-[11px] text-muted">{hint}</span> : null}
    </label>
  );
}

export function StatusEditorDialog({
  draft,
  tiles,
  tilesets,
  onCancel,
  onSave,
}: {
  draft: StatusSource;
  tiles: TileDef[];
  tilesets: TilesetDef[];
  onCancel: () => void;
  onSave: (status: StatusSource) => void;
}) {
  const [status, setStatus] = useState<StatusSource>(draft);
  const patch = (fields: Partial<StatusSource>) =>
    setStatus((current) => ({ ...current, ...fields }));

  const vfx = useMemo<StatusVfx>(
    () => ({
      tint: status.vfx?.tint ?? null,
      particles: status.vfx?.particles ?? null,
      light: status.vfx?.light ?? null,
      taperMs: status.vfx?.taperMs ?? 0,
    }),
    [status.vfx],
  );

  const icon = completeSprite(status.icon);
  const iconTileset = tilesets.find((t) => t.id === icon?.tilesetId) ?? null;

  const setIcon = (next: AnchoredSprite) =>
    patch({ icon: { ...next, base: next.base ?? defaultBase(next.rect) } });

  const setIconRect = (next: SpriteRef) => {
    if (!iconTileset) return;
    setIcon({ ...next, tilesetId: iconTileset.id });
  };
  const valid = resolveStatus(status) !== null;
  const cadenceSource = String(status.everyMs ?? 0);
  const cadenceMs = parseFormula(cadenceSource)?.evaluate(SAMPLE_SCOPE);
  const snapped = snapToTick(cadenceMs ?? 0);
  const cadenceHint =
    cadenceMs === undefined
      ? undefined
      : snapped === 0
        ? "fires nothing — for a status that only changes stats."
        : Math.abs(snapped - cadenceMs) < 1
          ? `every ${(snapped / 1000).toFixed(2)}s on the sample body.`
          : `snapped up to ${snapped.toFixed(1)}ms — cadences run in whole ticks.`;

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onCancel()}
      title={draft.id ? `Edit ${draft.id}` : "New status"}
      wide
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button disabled={!valid} onClick={() => onSave(status)}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-0.5">
            <span className="text-[11px] font-bold uppercase text-muted">Id</span>
            <Input value={status.id} onChange={(e) => patch({ id: e.target.value })} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[11px] font-bold uppercase text-muted">Name</span>
            <Input value={status.name} onChange={(e) => patch({ name: e.target.value })} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[11px] font-bold uppercase text-muted">Tone</span>
            <Select
              value={status.tone}
              onValueChange={(v) => patch({ tone: (v as StatusSource["tone"]) ?? "good" })}
              options={STATUS_TONES.map((t) => ({ value: t, label: t }))}
            />
          </label>
        </div>

        <label className="flex flex-col gap-0.5">
          <span className="text-[11px] font-bold uppercase text-muted">Description</span>
          <Input
            value={status.description}
            maxLength={MAX_STATUS_DESCRIPTION_LENGTH}
            onChange={(e) => patch({ description: e.target.value })}
          />
          <span className="text-[11px] text-muted">
            Tooltip on the status, and its accessible name. One line.
          </span>
        </label>

        <div className="border-t-2 border-border pt-3">
          <FieldLabel info="Its own picture rather than a borrowed tile, so it can come from anywhere on any sheet.">
            Icon
          </FieldLabel>
        </div>
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2">
              <span className="text-[11px] font-bold uppercase text-muted">Tileset</span>
              <Select
                value={icon?.tilesetId || null}
                onValueChange={(id) => {
                  if (!id) return;
                  const rect = icon?.rect ?? { x: 0, y: 0, w: 1, h: 1 };
                  setIcon({ tilesetId: id, rect, base: defaultBase(rect) });
                }}
                options={tilesets.map((t) => ({ value: t.id, label: t.name }))}
              />
            </label>
            <SpriteSelector tileset={iconTileset} value={icon} onChange={setIconRect} />
          </div>
          <div className="flex flex-col items-center gap-1">
            <span className="text-[11px] font-bold uppercase text-muted">In the lane</span>
            <SpritePreview sprite={icon} tilesets={tilesets} size={TITLE_SPRITE_SIZE_PX} />
          </div>
        </div>

        <div className="border-t-2 border-border pt-3">
          <FieldLabel info="Drawn once per application, both ends included. Equal ends for an exact lifetime.">
            Duration
          </FieldLabel>
        </div>
        <div className="flex flex-wrap gap-3">
          <MsField
            label="From (ms)"
            value={status.fromMs}
            onChange={(fromMs) => patch({ fromMs, toMs: Math.max(fromMs, status.toMs) })}
          />
          <MsField
            label="To (ms)"
            value={status.toMs}
            onChange={(toMs) => patch({ toMs, fromMs: Math.min(toMs, status.fromMs) })}
          />
          <label className="flex flex-col gap-0.5">
            <span className="text-[11px] font-bold uppercase text-muted">Stacks</span>
            <Switch
              checked={status.stacks}
              onCheckedChange={(stacks) => patch({ stacks })}
              ariaLabel="Re-applying adds to what is left"
            />
            <span className="text-[11px] text-muted">
              {status.stacks
                ? "Re-applying adds to what is left."
                : "Re-applying refreshes to the longer of the two."}
            </span>
          </label>
          <MsField
            label="Max (ms)"
            hint={status.stacks ? "Ceiling on the stack." : "Only read when it stacks."}
            value={status.maxMs ?? MAX_STATUS_DURATION_MS}
            onChange={(maxMs) => patch({ maxMs })}
          />
        </div>

        <div className="border-t-2 border-border pt-3">
          <FieldLabel info="Every is milliseconds between periods, as a number or a formula over the same variables as the effect — so a cadence can depend on MAX_HP, or on has_status('combat'). Hit points are signed. Positive heals and clamps at max HP; negative goes through the same damage path as a blow — shows a number, wakes the brains, and can kill.">
            Per period
          </FieldLabel>
        </div>
        <div className="flex flex-wrap items-start gap-3">
          <FormulaField
            label="Every (ms)"
            hint={cadenceHint}
            value={cadenceSource}
            onChange={(everyMs) => patch({ everyMs })}
          />
          <FormulaField
            label="Hit points"
            value={status.effects?.hp ?? ""}
            onChange={(hp) => patch({ effects: hp ? { hp } : {} })}
          />
        </div>

        <div className="border-t-2 border-border pt-3">
          <FieldLabel
            info={
              <>
                Added to the fighting stats every time they are read. Variables:{" "}
                <code>DURATION_SEC</code>, <code>REMAINING_SEC</code>, <code>ELAPSED_SEC</code>,{" "}
                <code>MAX_HP</code>, <code>HP</code>. Functions: ceil, floor, round, abs, min, max,
                and <code>has_status('id')</code>, which is 1 while the body is under that status.
                Previewed against a 16-point body 20 seconds into a 30-second run, under nothing
                else.
              </>
            }
          >
            Modifiers
          </FieldLabel>
        </div>
        <div className="flex flex-wrap gap-3">
          {MODIFIER_KEYS.map((key) => (
            <FormulaField
              key={key}
              label={key}
              value={status.modifiers?.[key] ?? ""}
              onChange={(source) => {
                const modifiers = { ...status.modifiers };
                if (source) modifiers[key] = source;
                else delete modifiers[key];
                patch({ modifiers });
              }}
            />
          ))}
        </div>

        <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
          <FieldLabel info="How much quicker or slower this makes the bearer walk. Zero is their own pace, -50 is half speed, 100 is twice it. Several sources add up before anything is divided, and the total is held between -90 and 400 — nothing may stop a body walking out of what it is under. A plain number rather than a formula: the browser times every step it draws and has no countdown for anybody but its viewer.">
            Walk speed %
          </FieldLabel>
          <NumberInput
            value={status.walkSpeedPercent ?? 0}
            min={MIN_WALK_SPEED_PERCENT}
            max={MAX_WALK_SPEED_PERCENT}
            onChange={(walkSpeedPercent) => patch({ walkSpeedPercent })}
            className="w-24"
            aria-label="Walk speed percent"
          />
        </div>

        <div className="flex flex-wrap gap-3 border-t-2 border-border pt-3">
          <label className="flex flex-col gap-0.5">
            <span className="text-[11px] font-bold uppercase text-muted">Incapacitates</span>
            <Switch
              checked={status.incapacitates ?? false}
              onCheckedChange={(incapacitates) => patch({ incapacitates })}
              ariaLabel="The bearer cannot act while this runs"
            />
            <span className="text-[11px] text-muted">
              {status.incapacitates
                ? "No walking, turning, attacking, casting, using or talking. Creatures stop thinking."
                : "The bearer acts as usual."}
            </span>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[11px] font-bold uppercase text-muted">Ends on damage</span>
            <Switch
              checked={status.endsOnDamage ?? false}
              onCheckedChange={(endsOnDamage) => patch({ endsOnDamage })}
              ariaLabel="Taking damage ends this"
            />
            <span className="text-[11px] text-muted">
              {status.endsOnDamage ? "Any damage taken ends it." : "Runs until its time is up."}
            </span>
          </label>
        </div>

        <div className="border-t-2 border-border pt-3">
          <FieldLabel info="Client-side only, never on the wire: the tint is applied where the body is drawn and the particles are simulated by whoever is watching. Walking off screen and back starts a fresh plume.">
            Visuals
          </FieldLabel>
        </div>
        <div className="flex flex-wrap items-start gap-4">
          <StatusVfxFields vfx={vfx} onChange={(next) => patch({ vfx: next })} />
          <VfxPreview vfx={vfx} tiles={tiles} tilesets={tilesets} winds />
        </div>

        {valid ? null : (
          <p className="border-2 border-danger p-2 text-[11px] text-danger">
            Something here is not valid — an id or name left blank, an inverted range, or a formula
            that does not parse. Saving is off until it is.
          </p>
        )}
      </div>
    </Dialog>
  );
}
