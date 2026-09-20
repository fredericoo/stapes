/**
 * The part of `WebSocket` a client actually uses.
 *
 * Stated as an interface so that *how you are connected* stops being the
 * client's business. `RemoteSession` reads frames off one of these and writes
 * frames back; whether the other end is a socket to a Bun process or a world
 * running in a worker in this same tab is a question it never asks. See
 * `../local/link`, which is where the two answers live.
 *
 * A real `WebSocket` satisfies this structurally, so the online path hands one
 * over unchanged and nothing on the wire moves.
 */
export interface ClientSocket {
  /** `WebSocket.readyState`. Compared against {@link SOCKET_OPEN}. */
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(
    type: "close",
    listener: (event: { code: number; reason: string }) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  removeEventListener(
    type: "close",
    listener: (event: { code: number; reason: string }) => void,
  ): void;
}

/**
 * `WebSocket.OPEN`, without needing the global.
 *
 * The constant is on the `WebSocket` constructor, which a session speaking to a
 * local world has no reason to reach for — and reaching for it is what would
 * tie this side to the browser's transport after everything else had been
 * untied from it.
 */
export const SOCKET_OPEN = 1;
