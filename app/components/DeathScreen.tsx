import type { DeathCost, LevelLost } from "../game/deathCost";
import { XP_SHARE_LOST_ON_DEATH } from "../game/experience";
import { MASTERY_LABELS } from "../lib/mastery";
import { LoadingScreen } from "./LoadingScreen";
import { Button } from "../ui";

const SHARE = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 1 });

const EXPERIENCE_LOST = `Each mastery lost ${SHARE.format(XP_SHARE_LOST_ON_DEATH)} of its experience.`;

export function DeathScreen({
  onRebirth,
  pending,
  cost,
  away,
}: {
  onRebirth: () => void;
  pending: boolean;
  cost: DeathCost | null;
  away: boolean;
}) {
  if (pending) {
    return (
      <div className="fixed inset-0 z-50">
        <LoadingScreen />
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex overflow-y-auto bg-ink/75 p-6"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="death-screen-title"
      aria-describedby="death-screen-cost"
    >
      {/**
       * Centred with `m-auto` rather than `items-center`, which pushes a panel
       * taller than the screen off both edges where it cannot be scrolled to.
       * A long list of levels at high zoom is exactly that panel.
       */}
      <div className="m-auto flex max-w-sm flex-col items-center gap-6 border-2 border-paper bg-ink px-8 py-7">
        <h2
          id="death-screen-title"
          className="text-center text-2xl font-bold tracking-wide uppercase text-paper"
        >
          {away ? "You died while you were away." : "You have died."}
        </h2>
        <div id="death-screen-cost" className="flex w-full flex-col gap-4">
          <div className="flex flex-col gap-2 text-center text-sm text-pretty text-paper/80">
            <p>
              {cost?.packLeft
                ? "Your bag stayed where you fell, with everything in it. You kept everything else."
                : "You kept everything you had."}
            </p>
            <p>{EXPERIENCE_LOST}</p>
          </div>
          {cost && cost.levelsLost.length > 0 ? <LevelsLost levels={cost.levelsLost} /> : null}
        </div>
        <Button variant="primary" autoFocus onClick={onRebirth}>
          {away ? "Continue" : "Rebirth"}
        </Button>
      </div>
    </div>
  );
}

function LevelsLost({ levels }: { levels: readonly LevelLost[] }) {
  return (
    <div className="flex flex-col gap-1">
      <h3
        id="death-screen-masteries"
        className="text-[11px] font-bold uppercase tracking-wide text-paper/50"
      >
        Masteries lowered
      </h3>
      <ul
        role="list"
        aria-labelledby="death-screen-masteries"
        className="grid grid-cols-1 gap-x-8 gap-y-1 text-xs tabular-nums sm:grid-cols-2"
      >
        {levels.map(({ mastery, from, to }) => (
          <li key={mastery} className="flex items-baseline gap-2">
            <span className="text-paper/80">{MASTERY_LABELS[mastery]}</span>
            <span className="whitespace-nowrap text-paper">
              {from}
              <span aria-hidden="true"> → </span>
              <span className="sr-only"> to </span>
              {to}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
