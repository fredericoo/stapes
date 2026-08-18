import { useState } from "react";
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
import { snapToTick } from "../game/statuses";
import { defaultBase, type SpriteRef, type TilesetDef } from "../lib/types";
import { Button, Dialog, Input, Select, Switch } from "../ui";
import { SpritePreview } from "./TilePreview";
import { SpriteSelector } from "./SpriteSelector";
import { TITLE_SPRITE_SIZE_PX } from "./ContainerPanel";

/**
 * Authoring one status.
 *
 * **The formulas are what makes this more than a form.** Everywhere else in the
 * editor a bad value is a number out of range and the schema says so; here a bad
 * value is a language error, and the failure mode is the quietest one in the
 * codebase — a formula that does not parse makes the whole status vanish from
 * every catalogue built from the file, with nothing on screen saying why.
 *
 * So every formula field is evaluated as it is typed, against a sample body, and
 * shown its own answer. That is the same argument `BattleTab` makes for its
 * derived stats: a readout that could disagree with the formula would be worse
 * than none, so it is run through the very function the simulation runs.
 */

/**
 * The body a formula is previewed against.
 *
 * Middling and stated rather than read off anything: what an author wants to know
 * is "what does this come to", and a preview that moved with whatever tile
 * happened to be selected would answer a different question each time.
 */
const SAMPLE_SCOPE: FormulaScope = {
  DURATION_SEC: 30,
  REMAINING_SEC: 20,
  ELAPSED_SEC: 10,
  MAX_HP: 16,
  HP: 9,
};

/** What a formula is worth against {@link SAMPLE_SCOPE}, or why it is not one. */
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
      <span
        className={`text-[11px] ${preview.ok ? "text-muted" : "text-danger"}`}
      >
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
      <Input
        type="number"
        min={0}
        max={MAX_STATUS_DURATION_MS}
        value={value}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
      />
      {hint ? <span className="text-[11px] text-muted">{hint}</span> : null}
    </label>
  );
}

export function StatusEditorDialog({
  draft,
  tilesets,
  onCancel,
  onSave,
}: {
  draft: StatusSource;
  tilesets: TilesetDef[];
  onCancel: () => void;
  onSave: (status: StatusSource) => void;
}) {
  const [status, setStatus] = useState<StatusSource>(draft);
  const patch = (fields: Partial<StatusSource>) =>
    setStatus((current) => ({ ...current, ...fields }));

  const icon = completeSprite(status.icon);
  const iconTileset = tilesets.find((t) => t.id === icon?.tilesetId) ?? null;

  /**
   * Keep the base cell inside the rectangle it belongs to.
   *
   * `SpriteSelector` hands back both together, but the tileset *select* only
   * changes the sheet — and a base left over from a wider rectangle on the last
   * sheet is out of bounds on this one.
   */
  const setIcon = (next: SpriteRef) =>
    patch({ icon: { ...next, base: next.base ?? defaultBase(next.rect) } });
  // The same function every catalogue is built with, so what this button is
  // gated on and what the world will accept cannot come apart.
  const valid = resolveStatus(status) !== null;
  // Authored milliseconds are not what the loop runs: a cadence that did not
  // divide the tick rate would drift, so it is snapped up — and an author is
  // told rather than left to find out.
  const snapped = snapToTick(status.everyMs ?? 0);
  const cadenceHint =
    !status.everyMs
      ? "0 fires nothing — for a status that only changes stats."
      : Math.abs(snapped - status.everyMs) < 1
        ? `Every ${(snapped / 1000).toFixed(2)}s.`
        : `Snapped up to ${snapped.toFixed(1)}ms — cadences run in whole ticks.`;

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
            <Input
              value={status.id}
              onChange={(e) => patch({ id: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[11px] font-bold uppercase text-muted">Name</span>
            <Input
              value={status.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[11px] font-bold uppercase text-muted">Tone</span>
            <Select
              value={status.tone}
              onValueChange={(v) =>
                patch({ tone: (v as StatusSource["tone"]) ?? "good" })
              }
              options={STATUS_TONES.map((t) => ({ value: t, label: t }))}
            />
          </label>
        </div>

        <label className="flex flex-col gap-0.5">
          <span className="text-[11px] font-bold uppercase text-muted">
            Description
          </span>
          <Input
            value={status.description}
            maxLength={MAX_STATUS_DESCRIPTION_LENGTH}
            onChange={(e) => patch({ description: e.target.value })}
          />
          {/* The only place a status is ever explained — it is the tooltip on a
              panel row and on a strip icon, and the second half of every icon's
              accessible name. */}
          <span className="text-[11px] text-muted">
            Shown on hover, and read aloud beside the icon. One line.
          </span>
        </label>

        <div className="flex flex-col gap-1 border-t-2 border-border pt-3">
          <span className="text-xs font-bold uppercase text-muted">Icon</span>
          <p className="max-w-lg text-[11px] leading-snug text-muted">
            Drag a rectangle on the sheet, the same way a tile's sprite is
            picked. Its own picture rather than a borrowed tile, so it can come
            from anywhere on any sheet.
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2">
              <span className="text-[11px] font-bold uppercase text-muted">
                Tileset
              </span>
              <Select
                value={icon?.tilesetId || null}
                onValueChange={(id) => {
                  if (!id) return;
                  // The rectangle is kept and the base recomputed: switching
                  // sheets to find the same shape elsewhere is the common move,
                  // and starting from 1×1 every time would undo it.
                  const rect = icon?.rect ?? { x: 0, y: 0, w: 1, h: 1 };
                  setIcon({ tilesetId: id, rect, base: defaultBase(rect) });
                }}
                options={tilesets.map((t) => ({ value: t.id, label: t.name }))}
              />
            </label>
            <SpriteSelector
              tileset={iconTileset}
              value={icon}
              onChange={setIcon}
            />
          </div>
          <div className="flex flex-col items-center gap-1">
            <span className="text-[11px] font-bold uppercase text-muted">
              In the lane
            </span>
            {/* At the size it is actually drawn at, not a big preview: the whole
                question an author has here is whether it reads at 18px beside a
                countdown, and a 96px version answers a different one. */}
            <SpritePreview
              sprite={icon}
              tilesets={tilesets}
              size={TITLE_SPRITE_SIZE_PX}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1 border-t-2 border-border pt-3">
          <span className="text-xs font-bold uppercase text-muted">Duration</span>
          <p className="max-w-lg text-[11px] leading-snug text-muted">
            Drawn once per application, both ends included. Equal ends mean an
            exact lifetime; an inverted range is malformed and reads as "not a
            status".
          </p>
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
            <span className="text-[11px] font-bold uppercase text-muted">
              Stacks
            </span>
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

        <div className="flex flex-col gap-1 border-t-2 border-border pt-3">
          <span className="text-xs font-bold uppercase text-muted">
            Per period
          </span>
          <p className="max-w-lg text-[11px] leading-snug text-muted">
            Signed: positive heals and clamps at the maximum, negative goes
            through the same damage the blows do — so it shows a number, tells the
            brains, and can kill.
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-3">
          <MsField
            label="Every (ms)"
            hint={cadenceHint}
            value={status.everyMs ?? 0}
            onChange={(everyMs) => patch({ everyMs })}
          />
          <FormulaField
            label="Hit points"
            value={status.effects?.hp ?? ""}
            onChange={(hp) => patch({ effects: hp ? { hp } : {} })}
          />
        </div>

        <div className="flex flex-col gap-1 border-t-2 border-border pt-3">
          <span className="text-xs font-bold uppercase text-muted">
            While it lasts
          </span>
          <p className="max-w-lg text-[11px] leading-snug text-muted">
            Added to the numbers a fight is fought with, every time they are read.
            Variables: <code>DURATION_SEC</code>, <code>REMAINING_SEC</code>,{" "}
            <code>ELAPSED_SEC</code>, <code>MAX_HP</code>, <code>HP</code>.
            Functions: ceil, floor, round, abs, min, max. Previewed against a
            16-point body 20 seconds into a 30-second run.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          {MODIFIER_KEYS.map((key) => (
            <FormulaField
              key={key}
              label={key}
              value={status.modifiers?.[key] ?? ""}
              onChange={(source) => {
                const modifiers = { ...(status.modifiers ?? {}) };
                if (source) modifiers[key] = source;
                else delete modifiers[key];
                patch({ modifiers });
              }}
            />
          ))}
        </div>

        {valid ? null : (
          <p className="border-2 border-danger p-2 text-[11px] text-danger">
            Something here is not valid — an id or name left blank, an inverted
            range, or a formula that does not parse. Saving is off until it is.
          </p>
        )}
      </div>
    </Dialog>
  );
}
