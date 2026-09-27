import type { ObjectRef } from "../game/affordances";
import type { CastSlot } from "../game/casting";
import type { CommandReply } from "../game/commands";
import type { TalkAction } from "../game/dialogRuntime";
import type { Equipment } from "../game/equipment";
import type { ActorSnapshot } from "../game/GameSession";
import type { ConsumeSource } from "../game/itemUse";
import type { MinutesOfDay } from "../lib/clock";
import { getStack } from "../lib/mapData";
import type { MasteryXp } from "../lib/mastery";
import type { Direction, PlacedTile } from "../lib/types";
import type { ServerMessage } from "../net/protocol";
import type { RemoteSession } from "../net/RemoteSession";
import type { FrameStats } from "../render/frameProfile";
import type { GameRenderer } from "../render/GameRenderer";
import type { DebugReading } from "../render/WorldRenderer";

export type StapesBody = {
  id: string;
  name: string | null;
  tileId: string;
  x: number;
  y: number;
  z: number;
  direction: Direction;
  hp: number | null;
  maxHp: number | null;
  statuses: { id: string; remainingMs: number }[];
  walking: boolean;
  casting: boolean;
  hidden: boolean;
};

export type StapesSnapshot = {
  selfId: string;
  minutesOfDay: MinutesOfDay;
  dead: boolean;
  targetId: string | null;
  attacking: boolean;
  equipment: Equipment;
  masteryXp: MasteryXp;
  bodies: StapesBody[];
};

export type StapesEventBody =
  | { kind: "notice"; text: string }
  | { kind: "chat"; actorId: string; text: string }
  | { kind: "damage"; targetId: string; outcome: string; amount: number }
  | { kind: "death"; actorId: string }
  | { kind: "swung"; actorId: string }
  | { kind: "projectile"; tileId: string; targetId: string | null; hit: boolean }
  | { kind: "spawned" | "despawned" | "joined" | "left" | "teleported"; actorId: string }
  | { kind: "statuses"; actorId: string; statusIds: string[] }
  | { kind: "died" }
  | { kind: "clock"; minutesOfDay: MinutesOfDay };

export type StapesEvent = StapesEventBody & { seq: number; atMs: number };

export type StapesAct =
  | { step: Direction }
  | { hold: Direction[] }
  | { face: Direction }
  | { target: string | null }
  | { attackMode: boolean }
  | { cast: CastSlot }
  | { cancelCast: true }
  | { interact: ObjectRef }
  | { pickUp: ObjectRef }
  | { equip: ObjectRef }
  | { consume: ConsumeSource }
  | { talk: TalkAction }
  | { say: string }
  | { rebirth: true };

export type StapesStats = { frame: FrameStats | null; debug: DebugReading | null };

export type Stapes = {
  command(text: string): Promise<CommandReply>;
  act(input: StapesAct): boolean;
  snapshot(): StapesSnapshot | null;
  stack(x: number, y: number, z: number): PlacedTile[];
  events(since?: number): StapesEvent[];
  logEvents(on: boolean): void;
  stats(): StapesStats;
  ready(options?: { timeoutMs?: number }): Promise<void>;
};

declare global {
  interface Window {
    __stapes?: Stapes;
  }
}

export const MAX_KEPT_EVENTS = 2_000;

export const DEFAULT_READY_TIMEOUT_MS = 30_000;

const READY_POLL_MS = 50;

export class StapesEventLog {
  private kept: StapesEvent[] = [];
  private seq = 0;
  private selfId = "";
  private readonly dead = new Set<string>();
  private mirror = false;

  readonly record = (message: ServerMessage) => {
    switch (message.type) {
      case "hello":
        this.selfId = message.selfId;
        return;
      case "notice":
        return this.push({ kind: "notice", text: message.text });
      case "chat":
        return this.push({ kind: "chat", actorId: message.actorId, text: message.text });
      case "died":
        return this.push({ kind: "died" });
      case "clock":
        return this.push({ kind: "clock", minutesOfDay: message.minutesOfDay });
      case "statuses":
        return this.push({
          kind: "statuses",
          actorId: this.selfId,
          statusIds: message.statuses.map((status) => status.defId),
        });
      case "patch":
        this.recordPatch(message);
        return;
    }
  };

  since(seq = 0): StapesEvent[] {
    return this.kept.filter((event) => event.seq > seq);
  }

  setMirror(on: boolean) {
    this.mirror = on;
  }

  private recordPatch(patch: Extract<ServerMessage, { type: "patch" }>) {
    for (const event of patch.events) {
      switch (event.kind) {
        case "damage":
          this.push({
            kind: "damage",
            targetId: event.targetId,
            outcome: event.outcome,
            amount: event.amount,
          });
          break;
        case "swung":
          this.push({ kind: "swung", actorId: event.actorId });
          break;
        case "projectileFired":
          this.push({
            kind: "projectile",
            tileId: event.tileId,
            targetId: event.targetId ?? null,
            hit: event.hit,
          });
          break;
        case "spawned":
        case "despawned":
        case "joined":
        case "left":
        case "teleported":
          this.push({ kind: event.kind, actorId: event.actorId });
          break;
      }
    }
    for (const { actorId, defIds } of patch.statusIds) {
      this.push({ kind: "statuses", actorId, statusIds: [...defIds] });
    }
    /**
     * The wire has no death event for a body other than your own; a body whose
     * health reaches nothing is reported once, until it has health again.
     */
    for (const { actorId, hp } of patch.hps) {
      if (hp > 0) {
        this.dead.delete(actorId);
      } else if (!this.dead.has(actorId)) {
        this.dead.add(actorId);
        this.push({ kind: "death", actorId });
      }
    }
  }

  private push(body: StapesEventBody) {
    const event = { ...body, seq: ++this.seq, atMs: Math.round(performance.now()) };
    this.kept.push(event);
    if (this.kept.length > MAX_KEPT_EVENTS) {
      this.kept = this.kept.slice(-MAX_KEPT_EVENTS);
    }
    if (this.mirror) console.info(`stapes:event ${JSON.stringify(event)}`);
  }
}

export type StapesSources = {
  session: () => RemoteSession | null;
  renderer: () => GameRenderer | null;
  painted: () => boolean;
  frameStats: () => FrameStats | null;
  log: StapesEventLog;
};

export function installStapes(sources: StapesSources): () => void {
  const stapes = createStapes(sources);
  window.__stapes = stapes;
  return () => {
    if (window.__stapes === stapes) delete window.__stapes;
  };
}

export function createStapes({
  session,
  renderer,
  painted,
  frameStats,
  log,
}: StapesSources): Stapes {
  return {
    command(text) {
      const live = session();
      if (!live) return Promise.reject(new Error("the world is not connected"));
      return live.command(text);
    },

    act(input) {
      const live = session();
      return live ? actOn(live, input) : false;
    },

    snapshot() {
      const live = session();
      if (!live?.isReady()) return null;
      const snap = live.getSnapshot();
      return {
        selfId: snap.self.id,
        minutesOfDay: live.minutesOfDay(),
        dead: live.isDead(),
        targetId: snap.targetId,
        attacking: snap.attacking,
        equipment: snap.equipment,
        masteryXp: snap.masteryXp,
        bodies: snap.actors.map(bodyOf),
      };
    },

    stack(x, y, z) {
      const live = session();
      if (!live) return [];
      return getStack(live.getMap(), x, y, z).map((placed) => ({ ...placed }));
    },

    events(since) {
      return log.since(since);
    },

    logEvents(on) {
      log.setMirror(on);
    },

    stats() {
      return { frame: frameStats(), debug: renderer()?.debugReading() ?? null };
    },

    ready({ timeoutMs = DEFAULT_READY_TIMEOUT_MS } = {}) {
      const waiting = (): string | null => {
        if (!session()?.isReady()) return "the world to connect";
        const drawing = renderer();
        if (!drawing || !painted()) return "the first frame";
        if (!drawing.isSettled()) return "the light to bake";
        if (document.fonts.status !== "loaded") return "the fonts to load";
        return null;
      };
      return new Promise((resolve, reject) => {
        const startedAt = performance.now();
        const poll = () => {
          const missing = waiting();
          if (missing === null) return resolve();
          if (performance.now() - startedAt > timeoutMs) {
            return reject(new Error(`still waiting for ${missing} after ${timeoutMs} ms`));
          }
          setTimeout(poll, READY_POLL_MS);
        };
        poll();
      });
    },
  };
}

function actOn(session: RemoteSession, input: StapesAct): boolean {
  if ("step" in input) {
    session.setInput({ directions: [input.step] });
    session.setInput({ directions: [] });
    return true;
  }
  if ("hold" in input) {
    session.setInput({ directions: [...input.hold] });
    return true;
  }
  if ("face" in input) {
    session.setInput({ directions: [input.face], faceOnly: true });
    session.setInput({ directions: [] });
    return true;
  }
  if ("target" in input) {
    session.setTarget(input.target);
    return true;
  }
  if ("attackMode" in input) {
    session.setAttackMode(input.attackMode);
    return true;
  }
  if ("cast" in input) return session.cast(input.cast);
  if ("cancelCast" in input) return session.cancelCast();
  if ("interact" in input) return session.interact(input.interact);
  if ("pickUp" in input) return session.pickUp(input.pickUp);
  if ("equip" in input) return session.equip(input.equip);
  if ("consume" in input) return session.consume(input.consume);
  if ("talk" in input) return session.talk(input.talk);
  if ("say" in input) {
    session.say(input.say);
    return true;
  }
  session.rebirth();
  return true;
}

function bodyOf(actor: ActorSnapshot): StapesBody {
  return {
    id: actor.id,
    name: actor.name,
    tileId: actor.tileId,
    x: actor.x,
    y: actor.y,
    z: actor.z,
    direction: actor.direction,
    hp: actor.hp,
    maxHp: actor.maxHp,
    statuses: actor.statuses.map((status) => ({
      id: status.defId,
      remainingMs: status.remainingMs,
    })),
    walking: actor.walk !== null,
    casting: actor.casting !== null,
    hidden: actor.hidden,
  };
}
