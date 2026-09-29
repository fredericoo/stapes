import { Toggle } from "../ui";
import type { PadSide } from "./padSide";

const SIDES: { side: PadSide; label: string }[] = [
  { side: "left", label: "Left" },
  { side: "right", label: "Right" },
];

export function PadSideToggle({
  side,
  onChange,
}: {
  side: PadSide;
  onChange: (side: PadSide) => void;
}) {
  return (
    <div role="group" aria-label="Joystick" className="flex items-center gap-1">
      {SIDES.map((option) => (
        <Toggle
          key={option.side}
          pressed={side === option.side}
          onPressedChange={() => onChange(option.side)}
          ariaLabel={option.label}
          size="sm"
        >
          {option.label}
        </Toggle>
      ))}
    </div>
  );
}
