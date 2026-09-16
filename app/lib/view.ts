/**
 * How much world a player can see at once.
 *
 * In `app/lib` rather than beside the camera that applies it, because it
 * stopped being only the client's business: the server sends each client the
 * part of the map its view can reach (`app/net/interest`), so the size of that
 * view is now a fact both halves have to agree on. Two answers to "how far can
 * they see" would be a strip of world that arrives unbuilt, or one that is
 * paid for and never drawn.
 */

/**
 * Cells across the square view. Odd, so the player stands in a true centre
 * cell rather than on the seam between two.
 */
export const VIEW_CELLS = 23;

/**
 * Cells of slack around the camera's own reach, before a window is rounded out
 * to whole chunks.
 *
 * Two things need it and neither is a safety margin. A sprite is drawn from
 * its cell *upward*, so a four-high tile a few rows below the bottom edge still
 * paints inside the view — the same reason `PARTICLE_WINDOW_MARGIN` exists, and
 * the same size, because a tall tile and a rising spark cover about the same
 * distance. And a chunk is built in the frame it comes into range, so the
 * margin is also how much warning that build gets: at 16 cells a chunk and a
 * margin of 6, a walker crosses into a new chunk column with most of a chunk
 * still to walk before any of it is on screen.
 *
 * Here beside {@link VIEW_CELLS} rather than in the renderer that applies it,
 * and moved for the reason that one lives here: the server now decides how far
 * away a *body* is worth telling a client about, and the answer is bounded by
 * what that client could draw. @see `../net/interest`
 */
export const MESH_WINDOW_MARGIN = 6;
