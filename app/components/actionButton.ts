export type ActionButtonSize = "touch" | "compact";

export const ACTION_BUTTON_SIZE_CLASS: Record<ActionButtonSize, string> = {
  touch: "aspect-square h-auto w-full max-w-14 flex-1",
  compact: "h-9 w-9 shrink-0",
};
