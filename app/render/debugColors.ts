/**
 * What each of the renderer's windows is drawn in under `?debug=1`.
 *
 * Shared by the outlines in the scene (`./WorldRenderer`) and the rows of the
 * panel beside them (`./debugPanel`), so the panel's colours always match the
 * rectangles it is the legend for.
 *
 * The play chrome has its own palette (`./GameRenderer`) and does not share
 * this one, so retoning a debug colour cannot change a play colour.
 */
export const DEBUG_COLORS = {
  /** The square the player can actually see. */
  play: 0xffffff,
  /** Chunk columns that exist as geometry right now. */
  mesh: 0x4ade80,
  /** How far past the view the light bake reads. */
  light: 0xfbbf24,
  /** Chunk columns this client has been sent — its subscription. */
  held: 0x60a5fa,
} as const;
