import { IconSkull } from "@tabler/icons-react";
import { useState } from "react";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Tooltip } from "../ui/Tooltip";
import { ACTION_BUTTON_SIZE_CLASS, type ActionButtonSize } from "./actionButton";
import { useTap } from "./useTap";

export type PvpPress = "explain" | "stop" | "nothing";

export function pvpPress(on: boolean, changeable: boolean): PvpPress {
  if (!changeable) return "nothing";
  return on ? "stop" : "explain";
}

export function PvpToggle({
  on,
  changeable,
  onChange,
  size = "touch",
}: {
  on: boolean;
  changeable: boolean;
  onChange: (on: boolean) => void;
  size?: ActionButtonSize;
}) {
  const [asking, setAsking] = useState(false);

  const tap = useTap(() => {
    const press = pvpPress(on, changeable);
    if (press === "stop") onChange(false);
    if (press === "explain") setAsking(true);
  });

  const label = on ? "Fighting other players" : "Not fighting other players";

  return (
    <>
      <Tooltip content={changeable ? label : `${label} — cannot change while in combat`}>
        <button
          type="button"
          aria-pressed={on}
          aria-label={label}
          disabled={!changeable}
          {...tap}
          className={[
            "flex items-center justify-center border-2 shadow-hard",
            ACTION_BUTTON_SIZE_CLASS[size],
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            on ? "border-danger bg-danger text-paper" : "border-paper/40 bg-transparent text-paper",
            changeable ? "" : "opacity-40",
          ].join(" ")}
        >
          <IconSkull size={size === "touch" ? 24 : 18} stroke={2} aria-hidden="true" />
        </button>
      </Tooltip>

      <Dialog
        open={asking}
        onOpenChange={setAsking}
        title="Turn PvP mode on?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setAsking(false);
                onChange(true);
              }}
            >
              Fight
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm">
          <p>Players who also turn this on can hurt you, and you can hurt them.</p>
          <p>Your name is marked while it is on.</p>
          <p>You cannot switch it off while in combat.</p>
        </div>
      </Dialog>
    </>
  );
}
