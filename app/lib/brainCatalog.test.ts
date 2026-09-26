import { describe, expect, it } from "vitest";
import {
  nearest,
  resolveBrain,
  slot,
  validateBrain,
  type BrainConditionDef,
  type BrainDef,
} from "./brain";
import { group } from "./conditions";
import {
  ACTIONS,
  ACTION_NAMES,
  CONDITIONS,
  CONDITION_NAMES,
  EFFECTS,
  EFFECT_NAMES,
} from "./brainCatalog";
import { normalizeTileDef, type TileDef } from "./types";
import { FRAME } from "./testTile";

function tileWithBrain(brain: BrainDef): TileDef {
  return normalizeTileDef({
    id: "creature",
    name: "creature",
    height: 2,
    directional: false,
    variants: { default: [FRAME] },
    attributes: {},
    actor: true,
    interactions: { brain },
  });
}

describe("the authoring catalog", () => {
  it("makes every action, condition and effect parse", () => {
    const brain: BrainDef = {
      initial: "s",
      states: {
        s: {
          onEnter: EFFECT_NAMES.map((n) => EFFECTS[n].make()),
          do: ACTION_NAMES.map((n) => ACTIONS[n].make()),
        },
      },
      transitions: CONDITION_NAMES.map((n) => ({
        from: "any" as const,
        if: CONDITIONS[n].make(),
        to: "s",
      })),
    };

    expect(resolveBrain(tileWithBrain(brain))).not.toBeNull();
    expect(validateBrain(brain).filter((i) => i.severity === "error")).toEqual([]);
  });

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
          bind: { spooked: nearest("player") },
          to: "flee",
        },
        { from: "flee", if: CONDITIONS.out_of_range.make(), to: "idle" },
      ],
    };

    const parsed = resolveBrain(tileWithBrain(brain));
    expect(parsed).toEqual(brain);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(brain);
  });
});

describe("the shapes a condition can grow", () => {
  it("round-trips a heard narrowed to one voice, either way round", () => {
    const brain: BrainDef = {
      initial: "idle",
      states: { idle: { do: [] }, busy: { do: [] } },
      transitions: [
        {
          from: "idle",
          if: {
            cond: "heard",
            text: "bye",
            cells: 4,
            los: true,
            from: { match: "is", of: slot("partner") },
          },
          to: "busy",
        },
        {
          from: "idle",
          if: {
            cond: "heard",
            text: "hi",
            cells: 4,
            from: { match: "not", of: slot("partner") },
          },
          to: "busy",
        },
      ],
    };

    expect(resolveBrain(tileWithBrain(brain))).toEqual(brain);
  });

  it("refuses a filter that names a match it does not have", () => {
    const brain = {
      initial: "idle",
      states: { idle: { do: [] } },
      transitions: [
        {
          from: "idle",
          if: {
            cond: "heard",
            text: "hi",
            cells: 4,
            from: { match: "maybe", of: slot("partner") },
          },
          to: "idle",
        },
      ],
    };
    expect(resolveBrain(tileWithBrain(brain as unknown as BrainDef))).toBeNull();
  });

  it("refuses a time of day past the last hour", () => {
    const brain: BrainDef = {
      initial: "idle",
      states: { idle: { do: [] } },
      transitions: [
        { from: "idle", if: { cond: "time_of_day", fromHour: 19, toHour: 24 }, to: "idle" },
      ],
    };
    expect(resolveBrain(tileWithBrain(brain))).toBeNull();
  });

  it("round-trips a nested group of conditions", () => {
    const brain: BrainDef = {
      initial: "idle",
      states: { idle: { do: [] }, alert: { do: [] } },
      transitions: [
        {
          from: "idle",
          if: group<BrainConditionDef>("or", [
            CONDITIONS.out_of_los.make(),
            group<BrainConditionDef>(
              "and",
              [CONDITIONS.after.make(), CONDITIONS.stuck.make()],
              true,
            ),
          ]),
          to: "alert",
        },
      ],
    };

    const parsed = resolveBrain(tileWithBrain(brain));
    expect(parsed).toEqual(brain);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(brain);
  });

  it("still flags a transition whose grouped condition leads nowhere", () => {
    const issues = validateBrain({
      initial: "idle",
      states: { idle: { do: [] } },
      transitions: [
        {
          from: "idle",
          if: group<BrainConditionDef>("and", [CONDITIONS.stuck.make()]),
          to: "gone",
        },
      ],
    });
    expect(issues).toContainEqual({
      severity: "error",
      message: 'Transition 1: goes to "gone", which is not a state.',
    });
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
