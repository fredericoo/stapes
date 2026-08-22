import { Select as BaseSelect } from "@base-ui/react/select";

export function Select({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  className = "",
  ariaLabel,
}: {
  value: string | null;
  onValueChange: (value: string | null) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  className?: string;
  /**
   * What this select is *for*, where the surrounding text cannot say it.
   *
   * The trigger is a button rather than a form control, so a `<label>` beside it
   * labels nothing — a caller whose caption is a `<span>` has a control that
   * reads out as its current value and no more. Optional, because most callers
   * sit inside a labelled row that already answers the question.
   */
  ariaLabel?: string;
}) {
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(v) => onValueChange(v as string | null)}
      items={options.map((o) => ({ value: o.value, label: o.label }))}
    >
      <BaseSelect.Trigger
        aria-label={ariaLabel}
        className={[
          "inline-flex min-w-[10rem] items-center justify-between gap-2 border-2 border-border bg-paper px-2 py-1 text-sm shadow-hard",
          "focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-accent",
          className,
        ].join(" ")}
      >
        <BaseSelect.Value placeholder={placeholder} />
        <BaseSelect.Icon className="text-muted">▾</BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner className="z-50" sideOffset={4}>
          <BaseSelect.Popup className="max-h-60 min-w-[var(--anchor-width)] overflow-auto border-2 border-border bg-paper shadow-hard">
            {options.map((opt) => (
              <BaseSelect.Item
                key={opt.value}
                value={opt.value}
                label={opt.label}
                className="cursor-pointer px-2 py-1.5 text-sm data-[highlighted]:bg-ink data-[highlighted]:text-paper"
              >
                <BaseSelect.ItemText>{opt.label}</BaseSelect.ItemText>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
