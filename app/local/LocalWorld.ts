import { GameServer } from "../../server/GameServer";

const LOCAL_PLAYER_NAME = "Tester";
import { GameSocket, SocketHub, type WorldContext } from "../../server/sockets";
import { DataStore } from "../lib/dataStore";
import { KEEPALIVE_INTERVAL_MS } from "../net/protocol";
import { ApiBlobs } from "./content";
import { idbCheckpoints, type Checkpoints } from "./checkpoints";
import { LocalStore } from "./LocalStore";

export class LocalWorld {
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private alarmTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private constructor(
    readonly server: GameServer,
    readonly store: LocalStore,
    readonly hub: SocketHub,
    private readonly checkpointIntervalMs: number,
  ) {}

  static async open({
    dataStore = new DataStore(new ApiBlobs()),
    checkpoints = idbCheckpoints(LOCAL_WORLD_DATABASE),
    checkpointIntervalMs = CHECKPOINT_INTERVAL_MS,
  }: {
    dataStore?: DataStore;
    checkpoints?: Checkpoints;
    checkpointIntervalMs?: number;
  } = {}): Promise<LocalWorld> {
    const store = new LocalStore(checkpoints);
    await store.restore();

    const hub = new SocketHub();
    const context: WorldContext = {
      storage: store,
      getWebSockets: () => hub.all(),
      acceptWebSocket: (socket) => hub.accept(socket),
    };

    const server = new GameServer(context, {
      dataStore,
      nameOf: async () => LOCAL_PLAYER_NAME,
    });
    const world = new LocalWorld(server, store, hub, checkpointIntervalMs);

    world.rearmAlarm(store.alarmAt());
    store.onAlarmChange = (atMs) => world.rearmAlarm(atMs);
    world.startCheckpointing();
    world.startKeepalive();
    return world;
  }

  private startCheckpointing() {
    this.checkpointTimer = setInterval(() => {
      if (!this.store.dirty) return;
      void this.store.flush().catch((error: unknown) => {
        console.error("[local] checkpoint failed", error);
      });
    }, this.checkpointIntervalMs);
  }

  private startKeepalive() {
    const frame = JSON.stringify({ type: "keepalive" });
    this.keepaliveTimer = setInterval(() => {
      if (this.stopped) return;
      for (const socket of this.hub.all()) socket.send(frame);
    }, KEEPALIVE_INTERVAL_MS);
  }

  private rearmAlarm(atMs: number | null) {
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    this.alarmTimer = null;
    if (atMs === null || this.stopped) return;

    this.alarmTimer = setTimeout(
      () => {
        this.alarmTimer = null;
        void this.server.alarm().catch((error: unknown) => {
          console.error("[local] alarm failed", error);
        });
      },
      Math.max(0, atMs - Date.now()),
    );
  }

  async join(socket: GameSocket, actorId: string): Promise<void> {
    await this.server.join(socket, actorId, { admin: true });
  }

  async message(socket: GameSocket, raw: string): Promise<void> {
    await this.server.webSocketMessage(socket, raw);
  }

  async leave(socket: GameSocket): Promise<void> {
    this.hub.drop(socket);
    await this.server.webSocketClose(socket);
  }

  async reset(): Promise<void> {
    await this.server.resetWorld();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    this.checkpointTimer = null;
    this.keepaliveTimer = null;
    this.alarmTimer = null;
    await this.store.flush();
  }
}

export const LOCAL_WORLD_DATABASE = "stapes-local-world";

const CHECKPOINT_INTERVAL_MS = 2000;
