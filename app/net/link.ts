import { rememberedCharacterId } from "../lib/playing";
import {
  CHARACTER_PARAM,
  GAME_SOCKET_PATH,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_PARAM,
} from "./protocol";
import type { ClientSocket } from "./socket";

export interface WorldLink {
  readonly id: string;
  open(): ClientSocket;
  reset?(): Promise<void>;
}

export const onlineLink: WorldLink = {
  id: "online",
  open() {
    const url = new URL(GAME_SOCKET_PATH, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set(PROTOCOL_VERSION_PARAM, String(PROTOCOL_VERSION));
    const character = rememberedCharacterId();
    if (character) url.searchParams.set(CHARACTER_PARAM, character);
    return new WebSocket(url);
  },
};
