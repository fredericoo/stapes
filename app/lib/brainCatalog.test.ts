import { describe, expect, it } from "vitest";
import { resolveBrain, validateBrain, type BrainDef } from "./brain";
import {
  ACTIONS,
  ACTION_NAMES,
  CONDITIONS,
  CONDITION_NAMES,
  EFFECTS,
  EFFECT_NAMES,
} from "./brainCatalog";
import { normalizeTileDef, type TileDef } from "./types";

/**
 * The editor authors a brain by name from a catalog, never by hand. Two things
 * have to hold for that to be safe: the catalog cannot offer a name the runtime
 * will not run, and a brain built from it survives the trip to disk unchanged.
 */

const frame = {
  sprite: { tilesetId: "basic", rect: { x: 0, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } },
  durationMs: 200,
};

function tileWithBrain(brain: BrainDef): TileDef {
  return normalizeTileDef({
    id: "creature",
    name: "creature",
    height: 1,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    actor: true,
    interactions: { brain },
  });
}

describe("the authoring catalog", () => {
  /**
   * The whole point of feeding the pickers from here: a name in the catalog is
   * a name the runtime implements, and a fresh instance of it is one the schema
   * accepts. If these ever drift, the editor could author an inert creature.
   */
  it("makes every action, condition and effect parse", () => {
    const brain: BrainDef = {
      initial: "s",
      states: {
        s: {
          onEnter: EFFECT_NAMES.map((n) => EFFECTS[n].make()),
          do: ACTION_NAMES.map((n) => ACTIONS[n].make()),
        },
      },
      // One transition per condition, all pointing back at the only state.
      transitions: CONDITION_NAMES.map((n) => ({
        from: "any" as const,
        if: CONDITIONS[n].make(),
        to: "s",
      })),
    };

    expect(resolveBrain(tileWithBrain(brain))).not.toBeNull();
    expect(validateBrain(brain).filter((i) => i.severity === "error")).toEqual([]);
  });

  /**
   * A brain assembled from catalog defaults is what the editor writes to
   * `tiles.json`. Parsing it back must return the very same object — no field
   * added, none dropped, none reordered into a different meaning.
   */
  it("round-trips a built brain through parse unchanged", () => {
    const brain: BrainDef = {
      initial: "idle",
      states: {
        idle: { do: [ACTIONS.hold.make()] },
        flee: {
          onEnter: [EFFECTS.say.make()],
          emit: { channel: "alarm", value: "on" },
          do: [ACTIONS.step_away_from.make(), ACTIONS.hold.make()],
        },
      },
      transitions: [
        {
          from: "any",
          if: CONDITIONS.in_range.make(),
          bind: { spooked: "nearest:player" },
          to: "flee",
        },
        { from: "flee", if: CONDITIONS.out_of_range.make(), to: "idle" },
      ],
    };

    const parsed = resolveBrain(tileWithBrain(brain));
    expect(parsed).toEqual(brain);
    // And byte-for-byte through JSON, which is the actual disk trip.
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(brain);
  });
});

describe("reporting what is wrong", () => {
  const ok: BrainDef = {
    initial: "idle",
    states: { idle: { do: [{ action: "hold" }] } },
    transitions: [],
  };

  it("passes a machine that holds together", () => {
    expect(validateBrain(ok)).toEqual([]);
  });

  it("flags a missing initial state", () => {
    const issues = validateBrain({ ...ok, initial: "dozing" });
    expect(issues).toContainEqual({
      severity: "error",
      message: 'Initial state "dozing" does not exist.',
    });
  });

  it("flags a transition to a state that does not exist", () => {
    const issues = validateBrain({
      ...ok,
      transitions: [{ from: "idle", if: { cond: "stuck" }, to: "gone" }],
    });
    expect(issues).toContainEqual({
      severity: "error",
      message: 'Transition 1: goes to "gone", which is not a state.',
    });
  });

  it("flags a transition from a state that does not exist", () => {
    const issues = validateBrain({
      ...ok,
      transitions: [{ from: "ghost", if: { cond: "stuck" }, to: "idle" }],
    });
    expect(issues).toContainEqual({
      severity: "error",
      message: 'Transition 1: from "ghost", which is not a state.',
    });
  });

  it("warns about a state nothing can reach", () => {
    const issues = validateBrain({
      initial: "idle",
      states: { idle: { do: [{ action: "hold" }] }, marooned: { do: [] } },
      transitions: [],
    });
    expect(issues).toContainEqual({
      severity: "warn",
      message: 'State "marooned" cannot be reached.',
    });
  });

  /**
   * A wildcard source reaches from everywhere, so a state only its `any`
   * transition leads to is reachable — the reachability walk must not report it.
   */
  it("counts a state reached only through a wildcard as reachable", () => {
    const issues = validateBrain({
      initial: "idle",
      states: { idle: { do: [] }, bolt: { do: [] } },
      transitions: [{ from: "any", if: { cond: "stuck" }, to: "bolt" }],
    });
    expect(issues.filter((i) => i.message.includes("bolt"))).toEqual([]);
  });

  it("refuses a state named the wildcard", () => {
    const issues = validateBrain({
      initial: "idle",
      states: { idle: { do: [] }, any: { do: [] } },
      transitions: [],
    });
    expect(issues).toContainEqual({
      severity: "error",
      message: 'A state cannot be named "any".',
    });
  });
});
