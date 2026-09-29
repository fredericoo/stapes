import { useEffect, useState, type ComponentProps, type KeyboardEvent } from "react";
import { Input } from "./Input";
import { parseNumberInput, type NumberRule } from "./numberParse";

type SharedProps = Omit<
  ComponentProps<typeof Input>,
  "value" | "onChange" | "type" | "min" | "max" | "step"
> & {
  min?: number;
  max?: number;
  step?: number;
};

function textOf(value: number | null | undefined): string {
  return value == null ? "" : String(value);
}

function useDraft({
  value,
  rule,
  onCommit,
}: {
  value: number | null | undefined;
  rule: NumberRule;
  onCommit: (next: number | null) => void;
}) {
  const [text, setText] = useState(() => textOf(value));
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (focused) return;
    setText(textOf(value));
    setError(null);
  }, [value, focused]);

  const commit = () => {
    const parsed = parseNumberInput(text, rule);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    setText(textOf(parsed.value));
    if (parsed.value !== (value ?? null)) onCommit(parsed.value);
  };

  const revert = () => {
    setText(textOf(value));
    setError(null);
  };

  return { text, setText, error, focused, setFocused, commit, revert };
}

function DraftInput({
  draft,
  rule,
  className = "",
  ...props
}: SharedProps & {
  draft: ReturnType<typeof useDraft>;
  rule: NumberRule;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      draft.commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      draft.revert();
    }
    props.onKeyDown?.(e);
  };

  return (
    <span className="inline-flex flex-col gap-0.5">
      <Input
        {...props}
        type="number"
        inputMode="decimal"
        min={rule.min}
        max={rule.max}
        step={rule.step ?? "any"}
        value={draft.text}
        aria-invalid={draft.error ? true : undefined}
        className={[className, draft.error ? "border-danger" : ""].filter(Boolean).join(" ")}
        onChange={(e) => draft.setText(e.target.value)}
        onFocus={(e) => {
          draft.setFocused(true);
          props.onFocus?.(e);
        }}
        onBlur={(e) => {
          draft.setFocused(false);
          draft.commit();
          props.onBlur?.(e);
        }}
        onKeyDown={onKeyDown}
      />
      {draft.error ? (
        <span role="alert" className="text-[11px] leading-snug text-danger">
          {draft.error}
        </span>
      ) : null}
    </span>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  ...props
}: SharedProps & {
  value: number;
  onChange: (next: number) => void;
}) {
  const rule: NumberRule = { min, max, step };
  const draft = useDraft({
    value,
    rule,
    onCommit: (next) => onChange(next ?? value),
  });
  return <DraftInput draft={draft} rule={rule} {...props} />;
}

export function OptionalNumberInput({
  value,
  onChange,
  min,
  max,
  step,
  ...props
}: SharedProps & {
  value: number | undefined;
  onChange: (next: number | undefined) => void;
}) {
  const rule: NumberRule = { min, max, step, allowBlank: true };
  const draft = useDraft({
    value,
    rule,
    onCommit: (next) => onChange(next ?? undefined),
  });
  return <DraftInput draft={draft} rule={rule} {...props} />;
}
