import { useMemo, useState } from "react";
import {
  catalogueBreaks,
  checkTrait,
  resolveTrait,
  traitShapeProblems,
  usesTrait,
  type TraitCatalogue,
  type TraitContext,
  type TraitDef,
  type TraitIssue,
} from "../lib/traits";
import type { TileDef } from "../lib/types";
import { Button, Dialog, Textarea } from "../ui";
import { describeParam } from "./brainText";
import { EditorIssues } from "./EditorIssues";

export const NEW_TRAIT = {
  id: "new-trait",
  name: "New trait",
  hint: "What a creature that calls this does, in a sentence or two.",
  params: {},
  states: {},
  triggers: [],
  transitions: [],
};

type Reading =
  | { def: null; problems: string[] }
  | { def: TraitDef; issues: TraitIssue[]; breaks: TraitIssue[]; clash: boolean };

function read(
  text: string,
  previous: string | null,
  catalogue: TraitCatalogue,
  tiles: readonly TileDef[],
  context: TraitContext,
): Reading {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { def: null, problems: [`This is not JSON yet: ${(error as Error).message}`] };
  }
  const def = resolveTrait(raw);
  if (!def) return { def: null, problems: traitShapeProblems(raw) };
  const after: Record<string, TraitDef> = { ...catalogue };
  if (previous !== null) delete after[previous];
  const clash = Object.hasOwn(after, def.id);
  after[def.id] = def;
  return {
    def,
    issues: checkTrait(def, after, context),
    breaks: catalogueBreaks(tiles, catalogue, after),
    clash,
  };
}

export function TraitEditorDialog({
  draft,
  previous,
  catalogue,
  tiles,
  context,
  error,
  saving,
  onCancel,
  onSave,
}: {
  draft: unknown;
  previous: string | null;
  catalogue: TraitCatalogue;
  tiles: TileDef[];
  context: TraitContext;
  error: string | null;
  saving: boolean;
  onCancel: () => void;
  onSave: (raw: unknown) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(draft, null, 2));
  const reading = useMemo(
    () => read(text, previous, catalogue, tiles, context),
    [text, previous, catalogue, tiles, context],
  );
  const users =
    previous === null
      ? []
      : tiles
          .filter((tile) => usesTrait(tile.interactions?.brain, previous, catalogue))
          .map((tile) => tile.name || tile.id);
  const errors = reading.def ? reading.issues.filter((one) => one.severity === "error") : [];
  const ready =
    reading.def !== null && !reading.clash && errors.length === 0 && reading.breaks.length === 0;

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onCancel()}
      title={previous === null ? "New trait" : `Edit ${previous}`}
      wide
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button disabled={!ready || saving} onClick={() => onSave(JSON.parse(text))}>
            {saving ? "Saving…" : "Save trait"}
          </Button>
        </>
      }
    >
      <div className="flex h-full flex-col gap-3 md:flex-row">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          aria-label="Trait, as JSON"
          className="min-h-[50vh] flex-1 font-mono text-xs leading-snug md:min-h-0"
        />
        <div className="flex w-full flex-col gap-3 text-[11px] leading-snug md:w-80 md:shrink-0">
          {error ? (
            <p role="alert" className="border-2 border-danger bg-danger/10 p-2 text-danger">
              {error}
            </p>
          ) : null}
          {reading.def === null ? (
            <EditorIssues
              issues={reading.problems.map((message) => ({ severity: "error", message }))}
            />
          ) : (
            <>
              <section className="flex flex-col gap-1">
                <h3 className="text-xs font-bold uppercase text-muted">Takes</h3>
                {Object.keys(reading.def.params).length === 0 ? (
                  <p className="text-muted">Nothing. A call to it has no arguments.</p>
                ) : (
                  <ul className="flex flex-col gap-0.5 font-mono">
                    {Object.entries(reading.def.params).map(([name, param]) => (
                      <li key={name}>{describeParam(name, param)}</li>
                    ))}
                  </ul>
                )}
              </section>
              {reading.clash ? (
                <EditorIssues
                  issues={[
                    {
                      severity: "error",
                      message: `Another trait is already called ${reading.def.id}. Pick a different id.`,
                    },
                  ]}
                />
              ) : null}
              <EditorIssues issues={reading.issues} />
              {reading.breaks.length > 0 ? (
                <section className="flex flex-col gap-1">
                  <h3 className="text-xs font-bold uppercase text-danger">
                    Saving would stop these working
                  </h3>
                  <EditorIssues issues={reading.breaks} />
                </section>
              ) : null}
            </>
          )}
          <section className="flex flex-col gap-1">
            <h3 className="text-xs font-bold uppercase text-muted">Called by</h3>
            <p className={users.length === 0 ? "text-muted" : ""}>
              {users.length === 0 ? "No creature yet." : users.join(", ")}
            </p>
          </section>
        </div>
      </div>
    </Dialog>
  );
}
