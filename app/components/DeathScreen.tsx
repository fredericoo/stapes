import { LoadingScreen } from "./LoadingScreen";
import { Button } from "../ui";

export function DeathScreen({ onRebirth, pending }: { onRebirth: () => void; pending: boolean }) {
  if (pending) {
    return (
      <div className="fixed inset-0 z-50">
        <LoadingScreen />
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/75 p-6"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="death-screen-title"
    >
      <div className="flex flex-col items-center gap-6 border-2 border-paper bg-ink px-8 py-7">
        <h2
          id="death-screen-title"
          className="text-center text-2xl font-bold tracking-wide uppercase text-paper"
        >
          You have died.
        </h2>
        <Button variant="primary" autoFocus onClick={onRebirth}>
          Rebirth
        </Button>
      </div>
    </div>
  );
}
