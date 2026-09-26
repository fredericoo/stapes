import type { ReactNode } from "react";
import { beats, type Element, ELEMENTS } from "../lib/element";
import { MASTERY_LABELS } from "../lib/mastery";
import { FieldLabel, Toggle } from "../ui";

export function ElementFields({
  label,
  info,
  elements,
  onChange,
}: {
  label: string;
  info: ReactNode;
  elements: Element[] | undefined;
  onChange: (elements: Element[]) => void;
}) {
  const chosen = elements ?? [];

  const toggle = (element: Element, on: boolean) => {
    onChange(
      ELEMENTS.filter((candidate) => (candidate === element ? on : chosen.includes(candidate))),
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

function ElementReading({ elements }: { elements: Element[] }) {
  if (elements.length === 0) return null;

  const weakTo = ELEMENTS.filter((against) => elements.some((element) => beats(against, element)));
  const resists = ELEMENTS.filter(
    (against) => !weakTo.includes(against) && elements.some((element) => beats(element, against)),
  );
  const named = (list: Element[]) => list.map((element) => MASTERY_LABELS[element]).join(", ");

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
