import { useState } from "react";
import type { Vitals } from "../game/GameSession";
import { HEALTH_BAR_STOPS, healthBarColor, healthFraction } from "../render/healthBar";

const LOW_HEALTH_FRACTION = HEALTH_BAR_STOPS[0]!.upTo;

export function HealthGauge({
  vitals,
  className = "",
}: {
  vitals: Pick<Vitals, "hp" | "maxHp">;
  className?: string;
}) {
  const { hp, maxHp } = vitals;
  const healing = useHealing(hp);
  if (hp === null || maxHp === null) return null;

  const fraction = healthFraction(hp, maxHp);
  const width = `${fraction * 100}%`;

  return (
    <div
      role="meter"
      aria-label="Health"
      aria-valuemin={0}
      aria-valuemax={maxHp}
      aria-valuenow={hp}
      aria-valuetext={`${hp} of ${maxHp}`}
      className={[
        "health-gauge relative h-5 w-full shrink-0 border border-paper/40 bg-ink",
        healing ? "health-gauge--healing" : "",
        fraction <= LOW_HEALTH_FRACTION ? "health-gauge--low" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="health-gauge__trail absolute inset-y-0 left-0" style={{ width }} />
      <span
        className="health-gauge__fill absolute inset-y-0 left-0"
        style={{ width, backgroundColor: healthBarColor(fraction) }}
      />
      <span
        aria-hidden="true"
        className="health-gauge__value relative flex h-full items-center justify-center text-detail leading-none tabular-nums text-paper"
      >
        {hp}
        <span className="text-paper/70">/{maxHp}</span>
      </span>
    </div>
  );
}

/**
 * Whether the last change in hp was upwards. Kept until the next change rather
 * than compared against the previous render, so a re-render mid-transition
 * does not swap which bar is easing.
 */
function useHealing(hp: number | null): boolean {
  const [last, setLast] = useState({ hp, healing: false });
  if (hp !== last.hp) {
    const healing = hp !== null && last.hp !== null && hp > last.hp;
    setLast({ hp, healing });
    return healing;
  }
  return last.healing;
}
