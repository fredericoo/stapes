import type { InteractionAction } from "../game/interactionOptions";

/**
 * `outline` is the world outline drawn round the thing under the pointer and
 * `ink` the text of its verb. `--color-interact` and `--color-reward` in
 * `app.css` repeat two of the outlines for the interaction list.
 */
export type InteractionColor = { outline: number; ink: string };

const INTERACT: InteractionColor = { outline: 0xffcc00, ink: "#ffe27a" };

export const INTERACTION_COLORS: Record<InteractionAction, InteractionColor> = {
  attack: { outline: 0xff3b30, ink: "#ff9b94" },
  target: { outline: 0xffffff, ink: "#ffffff" },
  reward: { outline: 0xb15cff, ink: "#d9a9ff" },
  talk: INTERACT,
  follow: INTERACT,
  open: INTERACT,
  consume: INTERACT,
  equip: INTERACT,
  pickUp: INTERACT,
  push: INTERACT,
  switch: INTERACT,
  teleport: INTERACT,
  addStatus: INTERACT,
  removeStatus: INTERACT,
  extract: INTERACT,
  craft: INTERACT,
};
