/**
 * What the page and the world in the worker say to each other.
 *
 * Deliberately thin. Everything that matters travels as `data` — the same JSON
 * frames the socket carries online, untouched — and this envelope carries only
 * what a socket's *existence* needs: which connection a frame belongs to, and
 * when one opens or closes. Parsing a frame is `app/net/protocol.ts`'s job on
 * both sides of this boundary, exactly as it is on both sides of a socket.
 *
 * Connections are numbered because there can be more than one over the life of
 * a worker: a reconnect is a new connection to the same world, and the frames
 * of the old one must not land on the new one.
 */

/** Page to world. */
export type ToWorld =
  | {
      kind: "open";
      id: number;
      /** Who is connecting. The local stand-in for the actor cookie. */
      actorId: string;
      /** What the page speaks. Refused exactly as the server refuses it. */
      protocolVersion: number;
    }
  | { kind: "frame"; id: number; data: string }
  | { kind: "close"; id: number }
  /** Destroy the world and start again on the authored map. */
  | { kind: "reset" };

/** World to page. */
export type FromWorld =
  | { kind: "frame"; id: number; data: string }
  | { kind: "closed"; id: number; code: number; reason: string };
