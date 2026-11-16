import { useTap } from "./useTap";

const ROW_CLASS =
  "flex min-h-6 w-full items-center gap-1 border px-1 py-0.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent pointer-coarse:min-h-11";
export const OPTION_CLASS = `${ROW_CLASS} hud-button text-paper aria-disabled:opacity-50`;
export const LABEL_CLASS = "truncate text-detail leading-snug font-medium tracking-tight";

export function PanelButton({
  onPress,
  className = OPTION_CLASS,
  disabled = false,
  children,
}: {
  onPress: () => void;
  className?: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const press = useTap(onPress);
  return (
    <button type="button" {...press} aria-disabled={disabled} className={className}>
      {children}
    </button>
  );
}
