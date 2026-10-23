import { slotTakes } from "../game/itemMoves";
import { resolveBattler } from "../lib/battler";
import {
  type BrainDef,
  isSelector,
  isSpeakerFilter,
  resolveBrain,
  type Selector,
  tilesNamedBy,
} from "../lib/brain";
import { ACTIONS, CONDITIONS, type ParamSpec } from "../lib/brainCatalog";
import { conditionLeaves } from "../lib/conditions";
import {
  resolveAddStatus,
  resolveCraft,
  resolveDecay,
  resolveEndure,
  resolveExtract,
  resolvePressurePlate,
  resolvePush,
  resolveReceive,
  resolveRemoveStatus,
  resolveSwitch,
} from "../lib/interactions";
import {
  type ArcaneStoneItem,
  resolveConsumable,
  resolveItem,
  type StatusGrant,
  type WeaponItem,
} from "../lib/item";
import { resolveProjectile } from "../lib/projectile";
import type { StatusDef } from "../lib/status";
import type { AnchoredSprite, TileDef, TilesetDef } from "../lib/types";
import type { Findings } from "./content";

export type Catalogue = {
  tilesById: Record<string, TileDef>;
  statusDefs: Record<string, StatusDef>;
  sheets: Map<string, TilesetDef | null>;
};

const CELL_PX = 8;

export function iconProblem(icon: AnchoredSprite, catalogue: Catalogue): string | null {
  const sheet = catalogue.sheets.get(icon.tilesetId);
  if (sheet === undefined) {
    return `The icon names sheet "${icon.tilesetId}", which tilesets.json does not list.`;
  }
  if (!sheet) return null;
  const { x, y, w, h } = icon.rect;
  if (x + w > Math.floor(sheet.width / CELL_PX) || y + h > Math.floor(sheet.height / CELL_PX)) {
    return `The icon's rect (${x},${y} ${w}×${h} cells) runs off ${sheet.name} (${sheet.width}×${sheet.height} px).`;
  }
  return null;
}

class References {
  constructor(
    private readonly id: string,
    private readonly catalogue: Catalogue,
    private readonly findings: Findings,
  ) {}

  error(path: string, message: string) {
    this.findings.error(this.id, path, message);
  }

  tile(path: string, subject: string, tileId: string): TileDef | null {
    const def = this.catalogue.tilesById[tileId];
    if (def) return def;
    this.error(path, `${subject} names tile "${tileId}", which tiles.json does not define.`);
    return null;
  }

  status(path: string, subject: string, statusId: string) {
    if (this.catalogue.statusDefs[statusId]) return;
    this.error(path, `${subject} names status "${statusId}", which statuses.json does not define.`);
  }

  grants(path: string, subject: string, grants: readonly StatusGrant[] | undefined) {
    grants?.forEach((grant, i) => this.status(`${path}[${i}].id`, subject, grant.id));
  }

  projectile(path: string, subject: string, tileId: string | undefined) {
    if (!tileId) return;
    const def = this.tile(path, subject, tileId);
    if (def && !resolveProjectile(def)) {
      this.error(path, `${subject} fires "${tileId}", which is not a projectile tile.`);
    }
  }

  weapon(path: string, subject: string, weapon: WeaponItem) {
    this.projectile(`${path}.projectile`, subject, weapon.projectile);
    this.grants(`${path}.statuses`, subject, weapon.statuses);
  }

  stone(path: string, subject: string, stone: ArcaneStoneItem) {
    const effect = stone.effect;
    if (effect.kind === "conjure") {
      this.tile(`${path}.effect.tileId`, subject, effect.tileId);
      return;
    }
    this.projectile(`${path}.effect.projectile`, subject, effect.projectile);
    this.grants(`${path}.effect.statuses`, subject, effect.statuses);
  }

  selector(path: string, subject: string, selector: Selector) {
    for (const tileId of tilesNamedBy(selector)) this.tile(path, subject, tileId);
  }

  brainParam(path: string, subject: string, spec: ParamSpec, value: unknown, spells: number) {
    if (value === undefined) return;
    const at = `${path}.${spec.key}`;
    if (
      (spec.kind === "selector" || spec.kind === "ground" || spec.kind === "aim") &&
      isSelector(value)
    ) {
      this.selector(at, subject, value);
    } else if (spec.kind === "speaker" && isSpeakerFilter(value)) {
      this.selector(at, subject, value.of);
    } else if (spec.kind === "status" && typeof value === "string") {
      this.status(at, subject, value);
    } else if (spec.kind === "spell" && typeof value === "number" && value > spells) {
      this.error(
        at,
        `${subject} casts spell ${value}, and this body has ${spellCount(spells)}, so the cast always fails.`,
      );
    } else if (spec.kind === "tile" && typeof value === "string") {
      const def = this.tile(at, subject, value);
      if (def && spec.tiles === "item" && !resolveItem(def)) {
        this.error(at, `${subject} names "${value}", which is not an item.`);
      }
      if (def && spec.tiles === "consumable" && !resolveConsumable(def)) {
        this.error(at, `${subject} names "${value}", which is not a consumable.`);
      }
    }
  }
}

function spellCount(spells: number): string {
  if (spells === 0) return "no spells";
  return spells === 1 ? "1 spell" : `${spells} spells`;
}

function field(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

function checkBrain(brain: BrainDef, spells: number, refs: References) {
  brain.transitions.forEach((transition, t) => {
    const at = `interactions.brain.transitions[${t}]`;
    for (const leaf of conditionLeaves(transition.if)) {
      for (const spec of CONDITIONS[leaf.cond].params) {
        refs.brainParam(
          `${at}.if`,
          `The ${leaf.cond} condition`,
          spec,
          field(leaf, spec.key),
          spells,
        );
      }
    }
    for (const [name, selector] of Object.entries(transition.bind ?? {})) {
      refs.selector(`${at}.bind.${name}`, `The bind "${name}"`, selector);
    }
  });
  for (const [state, def] of Object.entries(brain.states)) {
    def.do.forEach((action, a) => {
      for (const spec of ACTIONS[action.action].params) {
        refs.brainParam(
          `interactions.brain.states.${state}.do[${a}]`,
          `The ${action.action} action`,
          spec,
          field(action, spec.key),
          spells,
        );
      }
    });
  }
}

export function checkReferences(def: TileDef, catalogue: Catalogue, findings: Findings) {
  const refs = new References(def.id, catalogue, findings);

  def.connectsTo?.forEach((tileId, i) => refs.tile(`connectsTo[${i}]`, "connectsTo", tileId));

  resolvePush(def)?.moveOnTileIds.forEach((tileId, i) =>
    refs.tile(`interactions.push.moveOnTileIds[${i}]`, "The push block", tileId),
  );

  const sw = resolveSwitch(def);
  if (sw) refs.tile("interactions.switch.targetTileId", "The switch", sw.targetTileId);

  for (const recipe of resolveCraft(def)?.recipes ?? []) {
    const subject = recipe.name ? `Recipe "${recipe.name}"` : "A recipe";
    for (const input of recipe.inputs) {
      refs.tile("interactions.craft.recipes", subject, input.tileId);
    }
    for (const item of recipe.output.items) {
      refs.tile("interactions.craft.recipes", subject, item.tileId);
    }
  }

  const extract = resolveExtract(def);
  if (extract?.tileId)
    refs.tile("interactions.extract.tileId", "The extract block", extract.tileId);
  for (const slot of extract?.slots ?? []) {
    refs.tile("interactions.extract.slots", "The extract block", slot.tileId);
  }

  resolveEndure(def)?.suffers.forEach((affliction, i) => {
    const at = `interactions.endure.suffers[${i}]`;
    refs.status(`${at}.statusId`, "The endure block", affliction.statusId);
    if (affliction.tileId) refs.tile(`${at}.tileId`, "The endure block", affliction.tileId);
  });

  const decay = resolveDecay(def);
  if (decay?.tileId) refs.tile("interactions.decay.tileId", "The decay", decay.tileId);

  const plate = resolvePressurePlate(def);
  if (plate) refs.tile("interactions.pressurePlate.tileId", "The pressure plate", plate.tileId);

  const receive = resolveReceive(def);
  if (receive) refs.tile("interactions.receive.tileId", "The receive block", receive.tileId);

  const addStatus = resolveAddStatus(def);
  if (addStatus) {
    refs.status("interactions.addStatus.statusId", "The addStatus block", addStatus.statusId);
  }
  const removeStatus = resolveRemoveStatus(def);
  if (removeStatus) {
    refs.status(
      "interactions.removeStatus.statusId",
      "The removeStatus block",
      removeStatus.statusId,
    );
  }

  const battler = resolveBattler(def);
  if (battler) {
    battler.kit?.forEach((entry, i) => {
      const at = `interactions.battler.kit[${i}]`;
      const held = refs.tile(`${at}.tileId`, "The kit", entry.tileId);
      if (held && !slotTakes(entry.slot, held)) {
        refs.error(
          `${at}.slot`,
          `The kit puts "${entry.tileId}" in the ${entry.slot} slot, which does not take it, so the body is never born with it.`,
        );
      }
      entry.contents?.forEach((content, c) =>
        refs.tile(`${at}.contents[${c}].tileId`, "The kit", content.tileId),
      );
    });
    if (battler.remains) refs.tile("interactions.battler.remains", "The remains", battler.remains);
    refs.weapon("interactions.battler.naturalWeapon", "The natural weapon", battler.naturalWeapon);
    battler.immuneTo?.forEach((statusId, i) =>
      refs.status(`interactions.battler.immuneTo[${i}]`, "The immunity list", statusId),
    );
    battler.spells?.forEach((spell, i) => {
      const at = `interactions.battler.spells[${i}]`;
      refs.stone(at, `Spell "${spell.name}"`, spell);
      const problem = spell.icon ? iconProblem(spell.icon, catalogue) : null;
      if (problem) refs.error(`${at}.icon`, problem);
    });
  }

  const item = resolveItem(def);
  if (item?.type === "weapon") refs.weapon("interactions.item", "The weapon", item);
  if (item?.type === "stone") refs.stone("interactions.item", "The stone", item);
  if (item?.type === "charm") refs.grants("interactions.item.statuses", "The charm", item.statuses);
  if (item?.type === "consumable") {
    refs.grants("interactions.item.statuses", "The consumable", item.statuses);
    if (item.leaves) refs.tile("interactions.item.leaves", "The consumable", item.leaves);
  }

  const brain = resolveBrain(def);
  if (brain) checkBrain(brain, battler?.spells?.length ?? 0, refs);
}
