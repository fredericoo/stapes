/**
 * How much world a player can see at once.
 *
 * In `app/lib` rather than beside the camera that applies it, because it stopped
 * being only the client's business: the server sends each client the part of the
 * map its view can reach (`app/net/interest`), so the size of that view is now a
 * fact both halves have to agree on. Two answers to "how far can they see" would
 * be a strip of world that arrives unbuilt, or a strip that is paid for and never
 * drawn.
 */
import { CELL_SIZE } from "./types";

/**
 * Cells across the square view. Odd, so the player stands in a true centre cell
 * rather than on the seam between two.
 */
export const VIEW_CELLS = 23;

/** Side of the view in world pixels — what the camera spans on both axes. */
export const VIEW_PX = VIEW_CELLS * CELL_SIZE;
