import type { ReactNode } from "react";
import { beats, type Element, ELEMENTS } from "../lib/element";
import { MASTERY_LABELS } from "../lib/mastery";
import { FieldLabel, Toggle } from "../ui";

/**
 * The elements a thing carries, in the editor.
 *
 * **One control for the two places an element is authored**, because they are
 * the same decision asked of two objects: a battler says what a body *is*, and a
 * worn or held item says what carrying it *adds* to you. They union at the
 * moment a spell lands — see `../game/equipment`'s `bodyElements` — so
 * authoring them through two different-looking controls would invite an author
 * to believe they were two different systems.
 *
 * Deliberately **not** a picker over the element masteries in the requirements
 * grid. Those are the casting side: what a stone asks of you and what it is made
 * of. This is the receiving side, and reading one off the other is exactly the
 * conflation the model exists to avoid.
 */
export function ElementFields({
  label,
  info,
  elements,
  onChange,
}: {
  label: string;
  /** What ticking a box means here, in the terms of the panel it sits in. */
  info: ReactNode;
  elements: Element[] | undefined;
  onChange: (elements: Element[]) => void;
}) {
  const chosen = elements ?? [];

  const toggle = (element: Element, on: boolean) => {
    // Rebuilt off `ELEMENTS` rather than pushed and spliced, so the list is in
    // the canonical order however it was clicked — the same order the save
    // writes, which is what keeps a diff about what actually changed.
    onChange(
      ELEMENTS.filter((candidate) =>
        candidate === element ? on : chosen.includes(candidate),
      ),
    );
  };

  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel info={info}>{label}</FieldLabel>
      <div className="flex flex-wrap gap-2">
        {ELEMENTS.map((element) => (
          <Toggle
            key={element}
            size="sm"
            variant="secondary"
            pressed={chosen.includes(element)}
            onPressedChange={(on) => toggle(element, on)}
            ariaLabel={MASTERY_LABELS[element]}
          >
            {MASTERY_LABELS[element]}
          </Toggle>
        ))}
      </div>
      <ElementReading elements={chosen} />
    </div>
  );
}

/**
 * What the boxes ticked above come to, in a line.
 *
 * **The wheel is arithmetic nobody should have to do in their head**, and it is
 * doubly true here: ticking Fire decides what a spell does to you, which is the
 * opposite direction from the intuition that ticking Fire makes you good at
 * fire. Saying it out loud is cheaper than expecting every author to remember
 * which way round it runs.
 *
 * Absent for a neutral thing, which is almost everything — a line reading "this
 * is nothing in particular" on every rat and every loaf would be noise.
 */
function ElementReading({ elements }: { elements: Element[] }) {
  if (elements.length === 0) return null;

  const weakTo = ELEMENTS.filter((against) =>
    elements.some((element) => beats(against, element)),
  );
  const resists = ELEMENTS.filter(
    (against) =>
      !weakTo.includes(against) &&
      elements.some((element) => beats(element, against)),
  );
  const named = (list: Element[]) =>
    list.map((element) => MASTERY_LABELS[element]).join(", ");

  // Every element beats one and loses to one, so a thing made of all three is
  // hurt more by everything and less by everything, and the two cancel exactly.
  if (weakTo.length === ELEMENTS.length) {
    return (
      <p className="text-[11px] leading-snug text-muted">
        All three cancel: <strong>neutral to everything</strong>.
      </p>
    );
  }

  return (
    <p className="text-[11px] leading-snug text-muted">
      Weak to <strong>{named(weakTo)}</strong>
      {resists.length > 0 ? (
        <>
          , resists <strong>{named(resists)}</strong>
        </>
      ) : null}
      .
    </p>
  );
}
