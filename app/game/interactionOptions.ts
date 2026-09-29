import { getStack } from "../lib/mapData";
import type { InteractionKind } from "../lib/interactions";
import {
  DEFAULT_EXTRACT_VERB,
  resolveAddStatus,
  resolveRemoveStatus,
  resolveExtract,
  resolveRewardDef,
  resolveSetSpawn,
  resolveSwitch,
  resolveTeleportDef,
  craftVerb,
  DEFAULT_CRAFT_VERB,
} from "../lib/interactions";
import { consumeVerb, EQUIP_FALLBACK_VERB, equipVerb, resolveConsumable } from "../lib/item";
import type { Coord, MapFile, TileDef } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import type { Progress } from "./progress";
import {
  canAddStatusFrom,
  canRemoveStatusFrom,
  canConsumeFrom,
  canTalkFrom,
  canOpenFrom,
  canPickUpFrom,
  canPushFrom,
  canRewardFrom,
  canSetSpawnFrom,
  canSwitchFrom,
  canTeleportFrom,
  equipSlotFrom,
  INTERACT_LEVEL_SLACK,
  pickUpDestination,
  type EquipSlot,
  type ObjectRef,
} from "./affordances";
import { conjuredName } from "./conjured";
import { combatantOf, mayHarm } from "./pvp";
import { engravedName } from "../lib/engraving";
import { pileTally } from "../lib/piles";
import { bodyNameFor, bodyNameIn } from "./displayName";
import type { Equipment } from "./equipment";
import {
  extractFits,
  extractOfferedAt,
  extractionAt,
  pullsFreeAt,
  type Extraction,
} from "./extract";
import { offeredRecipes } from "./craft";
import type { ActorSnapshot, PlaySession } from "./GameSession";
import type { Conversation } from "./dialogRuntime";
import { hasLineOfSight } from "./sight";

export type InteractionAction =
  | InteractionKind
  | "target"
  | "attack"
  | "follow"
  | "talk"
  | "open"
  | "consume"
  | "equip";

export type InteractionOption = {
  id: string;
  action: InteractionAction;
  label: string;
  ref: ObjectRef;
  actorId: string | null;
  tileId: string;
  name: string;
  health: { hp: number; maxHp: number } | null;
  active: boolean;
  blocked: OptionBlock | null;
  wait: Progress | null;
};

export type OptionBlock =
  | { kind: "working"; extraction: Extraction }
  | { kind: "noRoom" }
  | { kind: "taken" }
  | { kind: "here" };

const LABELS: Record<InteractionAction, string> = {
  target: "Target",
  attack: "Attack",
  follow: "Follow",
  talk: "Talk to",
  open: "Open",
  pickUp: "Pick up",
  equip: EQUIP_FALLBACK_VERB,
  push: "Push",
  switch: "Switch",
  consume: "Use",
  reward: "Take",
  teleport: "Enter",
  addStatus: "Touch",
  removeStatus: "Touch",
  setSpawn: "Mark",
  extract: DEFAULT_EXTRACT_VERB,
  craft: DEFAULT_CRAFT_VERB,
};

const CLOSE_LABEL = "Close";

const NOTHING_EXTRACTING: Extraction | null = null;

export function interactionText(option: InteractionOption): string {
  return `${option.label} ${option.name}`;
}

const ACTION_ORDER: Record<InteractionAction, number> = {
  talk: 0,
  target: 1,
  attack: 2,
  follow: 3,
  reward: 4,
  teleport: 5,
  switch: 6,
  addStatus: 7,
  removeStatus: 8,
  setSpawn: 9,
  craft: 10,
  extract: 11,
  equip: 12,
  open: 13,
  pickUp: 14,
  consume: 15,
  push: 16,
};

export function topInteractionAt(
  options: readonly InteractionOption[],
  ref: ObjectRef,
): InteractionOption | null {
  let best: InteractionOption | null = null;
  const key = refKey(ref);
  for (const option of options) {
    if (refKey(option.ref) !== key) continue;
    if (option.blocked) continue;
    if (!best || ACTION_ORDER[option.action] < ACTION_ORDER[best.action]) {
      best = option;
    }
  }
  return best;
}

const TIER = {
  engaged: 0,
  adjacent: 1,
  inSight: 2,
  outOfSight: 3,
  otherFloor: 4,
} as const;

const ADJACENT_DISTANCE_SQUARED = 2;

const UNSEEN_SUBJECT_INDEX = Number.MAX_SAFE_INTEGER;

export function listInteractionOptions(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: ActorSnapshot,
  visibleActors: readonly ActorSnapshot[],
  targetId: string | null,
  equipment: Equipment,
  openedRef: ObjectRef | null = null,
  tags: readonly string[] = [],
  spawnAt: Coord | null = null,
  attacking: boolean = false,
  extracting: Extraction | null = NOTHING_EXTRACTING,
  conversation: Conversation | null = null,
  followId: string | null = null,
  previous: readonly InteractionOption[] = [],
  nextBlow: Progress | null = null,
  craftingRef: ObjectRef | null = null,
): InteractionOption[] {
  const bodies = bodiesByCell(self, visibleActors);
  const nameOf = bodyNameIn([self, ...visibleActors], tilesById);

  const options = [
    ...battlerOptions(tilesById, self, bodies, targetId, followId, attacking, nextBlow),
    ...talkOptions(map, tilesById, self, bodies, conversation),
    ...objectOptions(
      map,
      tilesById,
      self,
      bodies,
      nameOf,
      equipment,
      openedRef,
      tags,
      spawnAt,
      extracting,
      craftingRef,
    ),
  ];
  const tiers = tiersBySubject(map, tilesById, self, options);
  const held = subjectOrder(previous);
  const leads = leadsBySubject(options);

  return options
    .map((option) => {
      const subject = subjectKey(option);
      return {
        option,
        subject,
        tier: tiers.get(subject) ?? TIER.otherFloor,
        held: held.get(subject) ?? UNSEEN_SUBJECT_INDEX,
        distance: distanceFrom(self, option.ref),
        lead: leads.get(subject) ?? option,
      };
    })
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        a.held - b.held ||
        a.distance - b.distance ||
        (a.subject === b.subject ? compareRows(a.option, b.option) : compareRows(a.lead, b.lead)),
    )
    .map((ranked) => ranked.option);
}

function compareRows(a: InteractionOption, b: InteractionOption): number {
  return (
    ACTION_ORDER[a.action] - ACTION_ORDER[b.action] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function leadsBySubject(options: readonly InteractionOption[]): Map<string, InteractionOption> {
  const leads = new Map<string, InteractionOption>();
  for (const option of options) {
    const subject = subjectKey(option);
    const lead = leads.get(subject);
    if (!lead || compareRows(option, lead) < 0) leads.set(subject, option);
  }
  return leads;
}

function tiersBySubject(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: ActorSnapshot,
  options: readonly InteractionOption[],
): Map<string, number> {
  const tiers = new Map<string, number>();
  for (const option of options) {
    const subject = subjectKey(option);
    const tier = tierOf(map, tilesById, self, option);
    const best = tiers.get(subject);
    if (best === undefined || tier < best) tiers.set(subject, tier);
  }
  return tiers;
}

function tierOf(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: ActorSnapshot,
  option: InteractionOption,
): number {
  if (option.active || option.blocked?.kind === "working") return TIER.engaged;
  if (option.ref.z !== self.z) return TIER.otherFloor;
  if (distanceFrom(self, option.ref) <= ADJACENT_DISTANCE_SQUARED) {
    return TIER.adjacent;
  }
  return hasLineOfSight(map, tilesById, self, option.ref) ? TIER.inSight : TIER.outOfSight;
}

function subjectOrder(previous: readonly InteractionOption[]): Map<string, number> {
  const order = new Map<string, number>();
  for (const option of previous) {
    const subject = subjectKey(option);
    if (!order.has(subject)) order.set(subject, order.size);
  }
  return order;
}

export type InteractionGroup = {
  key: string;
  options: InteractionOption[];
};

export function groupInteractionOptions(options: readonly InteractionOption[]): InteractionGroup[] {
  const groups: InteractionGroup[] = [];
  const byKey = new Map<string, InteractionGroup>();

  for (const option of options) {
    const key = subjectKey(option);
    const existing = byKey.get(key);
    if (existing) {
      existing.options.push(option);
      continue;
    }
    const group: InteractionGroup = { key, options: [option] };
    byKey.set(key, group);
    groups.push(group);
  }

  return groups;
}

function subjectKey(option: InteractionOption): string {
  const subject = option.actorId ?? refKey(option.ref);
  return `${subject}|${option.tileId}|${option.name}`;
}

export function groupSubject(group: InteractionGroup): InteractionOption {
  return group.options[0];
}

export function actionRows(options: readonly InteractionOption[]): InteractionOption[][] {
  const rows: InteractionOption[][] = [];
  let pair: InteractionOption[] | null = null;

  for (const option of options) {
    if (option.action !== "attack" && option.action !== "target") {
      pair = null;
      rows.push([option]);
      continue;
    }
    if (!pair) {
      pair = [];
      rows.push(pair);
    }
    if (option.action === "target") pair.unshift(option);
    else pair.push(option);
  }

  return rows;
}

export function listedActionRows(options: readonly InteractionOption[]): InteractionOption[][] {
  return groupInteractionOptions(options).flatMap((group) => actionRows(group.options));
}

export function rowPress(row: readonly InteractionOption[]): InteractionOption | null {
  const watch = row.find((option) => option.action === "target");
  const fight = row.find((option) => option.action === "attack");
  if (watch && fight) return watch.active || fight.active ? fight : watch;
  const only = row[0];
  if (!only || only.blocked) return null;
  return only;
}

export type Follower = {
  setFollow(actorId: string | null): void;
  setCrafting(ref: ObjectRef | null): void;
};

export function applyInteraction(
  session: PlaySession | null,
  option: InteractionOption,
  follower: Follower | null = null,
) {
  if (option.blocked) return;
  if (option.action === "follow") {
    follower?.setFollow(option.active ? null : option.actorId);
    return;
  }
  if (option.action === "craft") {
    follower?.setCrafting(option.active ? null : option.ref);
    return;
  }
  if (!session) return;
  if (option.action === "attack") {
    if (option.active) {
      session.setAttackMode(false);
      return;
    }
    session.setTarget(option.actorId);
    session.setAttackMode(true);
    return;
  }
  if (option.action === "target") {
    session.setTarget(option.active ? null : option.actorId);
    session.setAttackMode(false);
    return;
  }
  if (option.action === "talk") {
    session.talk(option.active ? { kind: "close" } : { kind: "open", ref: option.ref });
    return;
  }
  if (option.action === "pickUp") {
    session.pickUp(option.ref);
    return;
  }
  if (option.action === "equip") {
    session.equip(option.ref);
    return;
  }
  if (option.action === "consume") {
    session.consume({ kind: "floor", ref: option.ref });
    return;
  }
  if (option.action === "open") return;
  session.interact(option.ref);
}

function refKey(ref: ObjectRef): string {
  return `${ref.x},${ref.y},${ref.z},${ref.stackIndex}`;
}

function bodiesByCell(
  self: ActorSnapshot,
  visibleActors: readonly ActorSnapshot[],
): Map<string, ActorSnapshot> {
  const bodies = new Map<string, ActorSnapshot>();
  for (const actor of visibleActors) {
    if (actor.id === self.id) continue;
    bodies.set(refKey(actor), actor);
  }
  return bodies;
}

function healthOf(actor: ActorSnapshot): { hp: number; maxHp: number } | null {
  if (actor.hp === null || actor.maxHp === null) return null;
  return { hp: actor.hp, maxHp: actor.maxHp };
}

function distanceFrom(self: ActorSnapshot, ref: ObjectRef): number {
  const dx = ref.x - self.x;
  const dy = ref.y - self.y;
  return dx * dx + dy * dy;
}

function objectOptions(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: ActorSnapshot,
  bodies: Map<string, ActorSnapshot>,
  nameOf: (actorId: string) => string | null,
  equipment: Equipment,
  openedRef: ObjectRef | null,
  tags: readonly string[],
  spawnAt: Coord | null,
  extracting: Extraction | null,
  craftingRef: ObjectRef | null,
): InteractionOption[] {
  const out: InteractionOption[] = [];
  const zMin = Math.max(MIN_LEVEL, self.z - INTERACT_LEVEL_SLACK);
  const zMax = Math.min(MAX_LEVEL, self.z + INTERACT_LEVEL_SLACK);

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const x = self.x + dx;
      const y = self.y + dy;

      for (let z = zMin; z <= zMax; z++) {
        const stack = getStack(map, x, y, z);
        for (let stackIndex = 0; stackIndex < stack.length; stackIndex++) {
          out.push(
            ...slotOptions(
              map,
              tilesById,
              self,
              bodies,
              nameOf,
              equipment,
              { x, y, z, stackIndex },
              openedRef,
              tags,
              spawnAt,
              extracting,
              craftingRef,
            ),
          );
        }
      }
    }
  }

  return out;
}

function slotOptions(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: ActorSnapshot,
  bodies: Map<string, ActorSnapshot>,
  nameOf: (actorId: string) => string | null,
  equipment: Equipment,
  ref: ObjectRef,
  openedRef: ObjectRef | null,
  tags: readonly string[],
  spawnAt: Coord | null,
  extracting: Extraction | null,
  craftingRef: ObjectRef | null,
): InteractionOption[] {
  const placed = getStack(map, ref.x, ref.y, ref.z)[ref.stackIndex];
  if (!placed) return [];
  if (placed.owner === self.id) return [];

  const body = bodies.get(refKey(ref));
  const tally = pileTally(placed);
  const name = body
    ? bodyNameFor(body, tilesById)
    : [
        conjuredName(
          engravedName(tilesById[placed.tileId]?.name ?? placed.tileId, placed.engraved),
          placed,
          nameOf,
        ),
        tally,
      ]
        .filter(Boolean)
        .join(" ");

  const out: InteractionOption[] = [];
  const add = (
    action: InteractionAction,
    label: string,
    active = false,
    blocked: OptionBlock | null = null,
  ) => {
    out.push({
      id: `${action}:${refKey(ref)}`,
      action,
      label,
      ref,
      actorId: body?.id ?? null,
      blocked,
      wait: null,
      tileId: placed.tileId,
      name,
      health: body ? healthOf(body) : null,
      active,
    });
  };

  const equipSlot = equipSlotFrom(map, tilesById, self, ref, equipment);
  const stow = pickUpDestination(map, tilesById, self, ref, equipment) != null;
  const action = objectAction(map, tilesById, self, ref, equipment, tags, equipSlot);
  if (action) {
    const blocked =
      action === "extract"
        ? extractBlock(map, tilesById, self, equipment, ref, extracting)
        : action === "setSpawn"
          ? spawnBlock(ref, spawnAt)
          : null;
    add(
      action,
      blocked?.kind === "here"
        ? SPAWN_HERE_LABEL
        : objectActionLabel(action, tilesById[placed.tileId]),
      false,
      blocked,
    );
  }

  if (action === "equip" && stow) add("pickUp", LABELS.pickUp);

  if (canOpenFrom(map, tilesById, self, ref)) {
    const isOpen = openedRef != null && refKey(openedRef) === refKey(ref);
    add("open", isOpen ? CLOSE_LABEL : LABELS.open, isOpen);
  }

  const offered = offeredRecipes(map, tilesById, self, equipment, ref);
  if (offered) {
    const isCrafting = craftingRef != null && refKey(craftingRef) === refKey(ref);
    add("craft", craftVerb(offered.craft), isCrafting);
  }

  if (canConsumeFrom(map, tilesById, self, ref)) {
    const def = tilesById[placed.tileId];
    const consumable = def ? resolveConsumable(def) : null;
    add("consume", consumable ? consumeVerb(consumable) : LABELS.consume);
  }

  return out;
}

function extractBlock(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: ActorSnapshot,
  equipment: Equipment,
  ref: ObjectRef,
  extracting: Extraction | null,
): OptionBlock | null {
  const extract = extractOfferedAt(map, tilesById, self, ref);
  if (!extract) return null;
  const mine = extractionAt(map, extracting, ref);
  if (mine) return { kind: "working", extraction: mine };
  if (!extractFits(extract, tilesById, equipment)) return { kind: "noRoom" };
  if (pullsFreeAt(map, tilesById, extract, ref) <= 0) return { kind: "taken" };
  return null;
}

function objectAction(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: ActorSnapshot,
  ref: ObjectRef,
  equipment: Equipment,
  tags: readonly string[],
  equipSlot: EquipSlot | null,
): InteractionAction | null {
  if (canRewardFrom(map, tilesById, self, ref, equipment, tags)) return "reward";
  const selfDef = tilesById[self.tileId];
  if (selfDef && canTeleportFrom(map, tilesById, self, ref, selfDef)) {
    return "teleport";
  }
  if (canSwitchFrom(map, tilesById, self, ref)) return "switch";
  if (canAddStatusFrom(map, tilesById, self, ref)) return "addStatus";
  if (canRemoveStatusFrom(map, tilesById, self, ref)) return "removeStatus";
  if (canSetSpawnFrom(map, tilesById, self, ref)) return "setSpawn";
  if (extractOfferedAt(map, tilesById, self, ref)) return "extract";
  if (equipSlot) return "equip";
  if (canPickUpFrom(map, tilesById, self, ref, equipment)) return "pickUp";
  if (canPushFrom(map, tilesById, self, ref)) return "push";
  return null;
}

function objectActionLabel(action: InteractionAction, def: TileDef | undefined): string {
  if (!def) return LABELS[action];
  if (action === "equip") return equipVerb(def);
  if (action === "switch") {
    return resolveSwitch(def)?.actionName?.trim() || LABELS.switch;
  }
  if (action === "reward") {
    return resolveRewardDef(def)?.actionName?.trim() || LABELS.reward;
  }
  if (action === "teleport") {
    return resolveTeleportDef(def)?.actionName?.trim() || LABELS.teleport;
  }
  if (action === "addStatus") {
    return resolveAddStatus(def)?.actionName?.trim() || LABELS.addStatus;
  }
  if (action === "removeStatus") {
    return resolveRemoveStatus(def)?.actionName?.trim() || LABELS.removeStatus;
  }
  if (action === "setSpawn") {
    return resolveSetSpawn(def)?.actionName?.trim() || LABELS.setSpawn;
  }
  if (action === "extract") {
    return resolveExtract(def)?.actionName?.trim() || LABELS.extract;
  }
  return LABELS[action];
}

const SPAWN_HERE_LABEL = "You respawn here";

function spawnBlock(ref: ObjectRef, spawnAt: Coord | null): OptionBlock | null {
  if (!spawnAt) return null;
  const here = ref.x === spawnAt.x && ref.y === spawnAt.y && ref.z === spawnAt.z;
  return here ? { kind: "here" } : null;
}

function talkOptions(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: ActorSnapshot,
  bodies: Map<string, ActorSnapshot>,
  conversation: Conversation | null,
): InteractionOption[] {
  const out: InteractionOption[] = [];
  for (const actor of bodies.values()) {
    const ref: ObjectRef = { x: actor.x, y: actor.y, z: actor.z, stackIndex: actor.stackIndex };
    if (!canTalkFrom(map, tilesById, self, ref)) continue;
    out.push({
      id: `talk:${actor.id}`,
      action: "talk",
      label: LABELS.talk,
      ref,
      actorId: actor.id,
      blocked: null,
      wait: null,
      tileId: actor.tileId,
      name: bodyNameFor(actor, tilesById),
      health: healthOf(actor),
      active: conversation?.npcId === actor.id,
    });
  }
  return out;
}

function battlerOptions(
  tilesById: Record<string, TileDef>,
  self: ActorSnapshot,
  bodies: Map<string, ActorSnapshot>,
  targetId: string | null,
  followId: string | null,
  attacking: boolean,
  nextBlow: Progress | null,
): InteractionOption[] {
  const out: InteractionOption[] = [];
  const me = combatantOf(self);

  for (const actor of bodies.values()) {
    if (actor.hp === null) continue;

    const ref: ObjectRef = {
      x: actor.x,
      y: actor.y,
      z: actor.z,
      stackIndex: actor.stackIndex,
    };
    const name = bodyNameFor(actor, tilesById);
    const health = healthOf(actor);
    const picked = actor.id === targetId;
    const fightable = mayHarm(me, combatantOf(actor));
    const fighting = fightable && picked && attacking;
    if (fightable) {
      out.push({
        id: `attack:${actor.id}`,
        action: "attack",
        label: LABELS.attack,
        ref,
        actorId: actor.id,
        blocked: null,
        wait: fighting ? nextBlow : null,
        tileId: actor.tileId,
        name,
        health,
        active: fighting,
      });
    }
    out.push({
      id: `target:${actor.id}`,
      action: "target",
      label: LABELS.target,
      ref,
      actorId: actor.id,
      blocked: null,
      wait: null,
      tileId: actor.tileId,
      name,
      health,
      active: fightable ? picked && !attacking : picked,
    });
    out.push({
      id: `follow:${actor.id}`,
      action: "follow",
      label: LABELS.follow,
      ref,
      actorId: actor.id,
      blocked: null,
      wait: null,
      tileId: actor.tileId,
      name,
      health,
      active: actor.id === followId,
    });
  }

  return out;
}
