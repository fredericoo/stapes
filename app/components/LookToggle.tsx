import { IconEye } from "@tabler/icons-react";

/**
 * Look at things, with a thumb.
 *
 * A mode rather than a modifier because a finger has no hover and no shift key:
 * the two things a tap could mean — act on this, tell me what this is — have to
 * be separated by something, and on touch that something is state you can see.
 * Tap once to look, tap again to stop.
 *
 * Blue while active, matching the outline it draws in the world. The colour is
 * the whole feedback loop: the button and the thing it is pointing at are lit
 * the same, so the mode never needs explaining.
 */
export function LookToggle({
  looking,
  onChange,
}: {
  looking: boolean;
  onChange: (looking: boolean) => void;
}) {
  return (
    <button
      type="button"
      // A toggle, said out loud: without this a screen reader announces a
      // button that seemingly does nothing, since the effect is a mode change
      // out in the canvas where there is nothing to announce.
      aria-pressed={looking}
      aria-label="Look at things"
      onClick={() => onChange(!looking)}
      className={[
        "flex h-14 w-14 items-center justify-center border-2 shadow-hard",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        // Outlined on the ink surround while off, exactly as the arrows beside
        // it are: filled chrome here reads as a lit button and undoes the whole
        // point of the blue meaning "on".
        looking
          ? "border-look bg-look text-ink"
          : "border-paper/40 bg-transparent text-paper",
      ].join(" ")}
    >
      <IconEye size={24} stroke={2} aria-hidden="true" />
    </button>
  );
}
