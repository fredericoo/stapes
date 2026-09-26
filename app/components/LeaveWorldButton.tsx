import { IconDoorExit } from "@tabler/icons-react";
import { useState } from "react";
import { Button, Dialog } from "../ui";

export function LeaveWorldButton({
  inCombat,
  onLeave,
}: {
  inCombat: boolean;
  onLeave: () => void;
}) {
  const [asking, setAsking] = useState(false);

  return (
    <>
      <Button
        variant="ghost-inverse"
        size="sm"
        onClick={() => (inCombat ? setAsking(true) : onLeave())}
      >
        <IconDoorExit size={16} stroke={2} aria-hidden="true" />
        Leave world
      </Button>
      <Dialog
        open={asking}
        onOpenChange={setAsking}
        title="Leave mid-fight"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAsking(false)}>
              Stay
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setAsking(false);
                onLeave();
              }}
            >
              Leave
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed">
          You are in a fight, so your body stays in the world until the fight is over — about a
          minute after the last blow lands. It stands still while it is there, and anything aimed at
          it still hits, with everything you are carrying on it.
        </p>
      </Dialog>
    </>
  );
}
