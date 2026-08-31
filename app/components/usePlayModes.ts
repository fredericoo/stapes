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

/**
 * The three things a tap can mean, of which exactly one is true.
 *
 * **They used to be two independent switches and that was the bug.** Looking and
 * fighting were separate latches, so a player could be in both at once, in
 * neither, and — the case people actually hit — in attack mode without any idea
 * they were, because nothing said what the *absence* of a mode was called.
 * Naming the third state is what makes the other two legible: "interact" is a
 * mode you can see you are in and can deliberately go back to, where "neither
 * button is lit" was a state you had to infer.
 */
export type PlayMode = "interact" | "inspect" | "attack";

export type PlayModes = {
  /**
   * The mode in force, which is what the buttons draw and what the world obeys.
   * Shift, while it is down, overrides whatever was chosen.
   */
  mode: PlayMode;
  /** Shorthand the renderer and the panels are already written in terms of. */
  looking: boolean;
  attacking: boolean;
  /** Choose a mode. Shift being down still wins until it comes up. */
  setMode: (mode: PlayMode) => void;
};

/**
 * What the switch reads as, given what was chosen and whether shift is down.
 *
 * The whole of "revert to the previous one on release": the chosen mode is never
 * overwritten, only covered, so letting go of the key uncovers it. There is no
 * remembered previous mode to get out of step with what the buttons say.
 */
export function modeInForce(chosen: PlayMode, lookHeld: boolean): PlayMode {
  return lookHeld ? "inspect" : chosen;
}

/**
 * Where the attack key takes the machine from here.
 *
 * A way in and a way out, so E is the whole of the keyboard's story about
 * fighting: pressed while already fighting it puts the sword away, which is the
 * same thing tapping the lit button does. It returns to plain interaction rather
 * than to whatever came before, because "before" was very often inspect and
 * ending a fight by dropping into look mode is not what anybody means.
 */
export function modeAfterAttackKey(chosen: PlayMode): PlayMode {
  return chosen === "attack" ? "interact" : "attack";
}

export function usePlayModes(): PlayModes {
  /**
   * What was chosen, and separately whether shift is down.
   *
   * Two pieces of state for one mode, and that is the point. Shift is momentary
   * and a button is a latch, and folding them into one value makes them fight: a
   * keyup cannot tell whether the mode it is ending was one the key started, so
   * with a single value a tap of shift would quietly cancel a mode the player had
   * chosen with a button. Kept apart, the key says only "held" and the choice
   * survives underneath it — which is exactly what "revert to the previous one on
   * release" means, with no previous-mode bookkeeping to get wrong.
   */
  const [chosen, setChosen] = useState<PlayMode>("interact");
  const [lookHeld, setLookHeld] = useState(false);

  useEffect(() => {
    const unbindLook = bindLookKey(setLookHeld);
    // Reported as a press rather than a state, so the key and the button are
    // moving the one machine instead of each holding an opinion about it.
    const unbindAttack = bindAttackKey(() => setChosen(modeAfterAttackKey));
    return () => {
      unbindLook();
      unbindAttack();
    };
  }, []);

  const mode = modeInForce(chosen, lookHeld);

  return {
    mode,
    looking: mode === "inspect",
    attacking: mode === "attack",
    setMode: setChosen,
  };
}
