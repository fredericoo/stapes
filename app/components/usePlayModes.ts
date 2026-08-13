import { useEffect, useState } from "react";
import { bindAttackKey, bindLookKey } from "../game/heldDirections";

/**
 * What a tap on the world currently means, and the keys that change it.
 *
 * Held here rather than in either page because both play routes need exactly the
 * same thing and had already grown one copy each of the look-mode wiring. The
 * modes are not independent of each other in kind — they are the same question
 * asked twice — so answering it in one place is also what keeps them behaving
 * alike.
 *
 * Nothing in here touches a session or a renderer. It owns the *decision*; the
 * page owns pushing it at whatever is currently on the other end of the socket,
 * which is the part that differs between a local simulation and a reconnecting
 * one.
 */
export type PlayModes = {
  /** Shift is down, or the button is latched on. */
  looking: boolean;
  attacking: boolean;
  /** The button's half of look mode. The keyboard's half is not overwritten. */
  setLookLatched: (looking: boolean) => void;
  setAttacking: (attacking: boolean) => void;
};

export function usePlayModes(): PlayModes {
  /**
   * Two booleans for looking, and that is the point.
   *
   * Shift is momentary and the button is a latch, and folding them into one flag
   * makes them fight: with a single flag, tapping shift and letting go turns off
   * a mode the player had clicked on, because a keyup cannot tell what turned
   * the mode on in the first place. Kept apart, each input only ever says its
   * own half and the mode is on while either says so.
   */
  const [lookLatched, setLookLatched] = useState(false);
  const [lookHeld, setLookHeld] = useState(false);
  const [attacking, setAttacking] = useState(false);

  useEffect(() => {
    const unbindLook = bindLookKey(setLookHeld);
    // Reported as a press rather than a state, so the key and the button are
    // toggling the one flag instead of each holding an opinion about it.
    const unbindAttack = bindAttackKey(() =>
      setAttacking((current) => !current),
    );
    return () => {
      unbindLook();
      unbindAttack();
    };
  }, []);

  return {
    looking: lookLatched || lookHeld,
    attacking,
    setLookLatched,
    setAttacking,
  };
}
