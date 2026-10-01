import { carriedInstances, carriedLightTileIds, type Equipment } from "../app/game/equipment";
import { carriedCount, planTrade } from "../app/game/trade";
import type { BattlerDef } from "../app/lib/battler";
import type { TradeSide } from "../app/lib/dialog";
import { countOf } from "../app/lib/piles";
import type { StatusDef } from "../app/lib/status";
import { resolveLight } from "../app/lib/tileResolve";
import type { TileDef } from "../app/lib/types";
import { healing } from "./combat";
import { bestUpgrade, type Style } from "./gear";
import { currencyOf, offersIn, type Offer } from "./shops";

/** Healing food a bot keeps rather than sells, and buys back up to when it runs low. */
export const FOOD_RESERVE = 4;

/**
 * An upgrade must add at least this much (damage a second, or defence) to be
 * worth a trip to the shop; anything less is a rounding difference between
 * two rungs.
 */
export const MIN_GAIN = 0.25;

export type Deal = { readonly offer: Offer; readonly amount: number; readonly why: string };

/**
 * What a bot knows about the economy: every trade every NPC offers, read
 * from the tile catalogue, and what those trades make each thing worth to
 * this bot as it is now.
 */
export class Economy {
  readonly offers: readonly Offer[];
  readonly currency: string | null;

  constructor(
    readonly tilesById: Record<string, TileDef>,
    readonly statusDefs: Record<string, StatusDef>,
    readonly style: Style,
  ) {
    this.offers = offersIn(tilesById);
    this.currency = currencyOf(this.offers);
  }

  /** Every gear offer that would make the bot better, best first. */
  upgrades(equipment: Equipment, body: BattlerDef): Array<{ offer: Offer; gain: number }> {
    const out: Array<{ offer: Offer; gain: number }> = [];
    for (const offer of this.offers) {
      const bought = soleGive(offer);
      const def = bought && this.tilesById[bought];
      const upgrade = def && bestUpgrade(def, equipment, this.tilesById, body, this.style);
      if (upgrade && upgrade.gain >= MIN_GAIN) out.push({ offer, gain: upgrade.gain });
    }
    return out.sort((a, b) => b.gain - a.gain);
  }

  /**
   * The trades worth going to make now, most wanted first: food when the bag
   * holds less than half of `FOOD_RESERVE`, then every upgrade the bot can
   * pay for.
   */
  purchases(equipment: Equipment, body: BattlerDef): Deal[] {
    const out: Deal[] = [];
    const food = this.foodCount(equipment);
    if (food < FOOD_RESERVE / 2) {
      for (const offer of this.foodOffers()) {
        const amount = this.affordable(offer, equipment, FOOD_RESERVE - food);
        if (amount > 0) out.push({ offer, amount, why: "food" });
      }
    }
    for (const { offer } of this.upgrades(equipment, body)) {
      if (this.affordable(offer, equipment, 1) > 0) out.push({ offer, amount: 1, why: "upgrade" });
    }
    return out;
  }

  /**
   * The upgrade worth most for what it costs, which is what the bot saves
   * for when it can afford none.
   */
  savingFor(equipment: Equipment, body: BattlerDef): Offer | null {
    let best: Offer | null = null;
    let bestRatio = 0;
    for (const { offer, gain } of this.upgrades(equipment, body)) {
      const ratio = gain / Math.max(1, this.price(offer));
      if (ratio > bestRatio) {
        best = offer;
        bestRatio = ratio;
      }
    }
    return best;
  }

  /** Everything the bot carries and does not need that an NPC pays money for. */
  sales(equipment: Equipment, body: BattlerDef): Deal[] {
    const saving = this.savingFor(equipment, body);
    const out: Deal[] = [];
    for (const offer of this.offers) {
      if (!this.paysMoney(offer) || offer.take.length !== 1) continue;
      const side = offer.take[0]!;
      if (saving?.take.some((s) => s.tileId === side.tileId)) continue;
      const surplus = carriedCount(this.tilesById, equipment, side.tileId) - this.keep(side.tileId);
      const amount = Math.min(offer.max, Math.floor(surplus / side.count));
      if (amount < offer.min) continue;
      if (this.affordable(offer, equipment, amount) < amount) continue;
      out.push({ offer, amount, why: "sale" });
    }
    return out;
  }

  /**
   * What is worth picking up off the floor, as a test on a tile id: money,
   * anything the bot is saving for, anything an NPC buys, food while it has
   * little, a light while it has none, and gear better than what it wears
   * that it does not already carry one of.
   * Built once for a decision, since it is asked of every thing in view.
   */
  wanted(equipment: Equipment, body: BattlerDef): (tileId: string) => boolean {
    const saving = new Set(this.savingFor(equipment, body)?.take.map((side) => side.tileId));
    const hungry = this.foodCount(equipment) < FOOD_RESERVE * 2;
    const dark = carriedLightTileIds(equipment, this.tilesById).length === 0;
    const carried = new Set(carriedInstances(equipment).map((instance) => instance.tileId));
    return (tileId) => {
      const def = this.tilesById[tileId];
      if (!def) return false;
      if (tileId === this.currency || saving.has(tileId) || this.bought(tileId)) return true;
      if (hungry && healing(def, this.statusDefs) > 0) return true;
      if (dark && resolveLight(def, {}) !== undefined) return true;
      if (carried.has(tileId)) return false;
      return (bestUpgrade(def, equipment, this.tilesById, body, this.style)?.gain ?? 0) > 0;
    };
  }

  /** Whether some NPC pays money for this. */
  bought(tileId: string): boolean {
    return this.offers.some(
      (offer) => this.paysMoney(offer) && offer.take.some((side) => side.tileId === tileId),
    );
  }

  /** What an offer costs, counted in the currency; anything else counts one a unit. */
  price(offer: Offer): number {
    return offer.take.reduce((sum, side) => sum + side.count, 0);
  }

  /** How many times, up to `wanted`, the bot could make this trade with what it carries. */
  affordable(offer: Offer, equipment: Equipment, wanted: number): number {
    for (let amount = Math.min(wanted, offer.max); amount >= Math.max(1, offer.min); amount--) {
      const times = (side: TradeSide) => ({ tileId: side.tileId, count: side.count * amount });
      const take = offer.take.map(times);
      const give = offer.give.map(times);
      if (planTrade(this.tilesById, equipment, take, give, mintNothing) !== null) return amount;
    }
    return 0;
  }

  foodCount(equipment: Equipment): number {
    let count = 0;
    for (const instance of carriedInstances(equipment)) {
      const def = this.tilesById[instance.tileId];
      if (def && healing(def, this.statusDefs) > 0) count += countOf(instance);
    }
    return count;
  }

  /** Offers that sell food that heals, cheapest for the health first. */
  private foodOffers(): Offer[] {
    return this.offers
      .filter((offer) => {
        const tileId = soleGive(offer);
        const def = tileId ? this.tilesById[tileId] : undefined;
        return def !== undefined && healing(def, this.statusDefs) > 0;
      })
      .sort((a, b) => this.price(a) / this.healed(a) - this.price(b) / this.healed(b));
  }

  private healed(offer: Offer): number {
    const def = this.tilesById[soleGive(offer) ?? ""];
    return Math.max(1, def ? healing(def, this.statusDefs) : 0);
  }

  private paysMoney(offer: Offer): boolean {
    return (
      this.currency !== null &&
      offer.give.length > 0 &&
      offer.give.every((side) => side.tileId === this.currency)
    );
  }

  private keep(tileId: string): number {
    const def = this.tilesById[tileId];
    return def && healing(def, this.statusDefs) > 0 ? FOOD_RESERVE : 0;
  }
}

function soleGive(offer: Offer): string | null {
  return offer.give.length === 1 && offer.give[0]!.count === 1 ? offer.give[0]!.tileId : null;
}

function mintNothing(): string {
  return "planned";
}
