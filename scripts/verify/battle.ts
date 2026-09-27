import { join } from "node:path";
import { statusesById } from "../../app/lib/status";
import { normalizeTiles } from "../../app/lib/types";
import {
  type BattleOptions,
  type BattleReport,
  type Catalogue,
  type HandRates,
  runBattle,
  type SideReport,
  type Spread,
} from "../../app/verify/battle";
import { KITS, parseSide, SideError, type Subject } from "../../app/verify/sides";
import { traceBattle, type TraceEvent, type TraceReport } from "../../app/verify/trace";
import {
  choice,
  type Command,
  type Outcome,
  type Parsed,
  percent,
  table,
  UsageError,
  wholeNumber,
} from "./cli";

const DATA = join(import.meta.dir, "../../data");

const DEFAULT_SEEDS = 1000;
const DEFAULT_MAX_SECONDS = 120;

async function catalogue(): Promise<Catalogue> {
  const tiles = normalizeTiles(await Bun.file(join(DATA, "tiles.json")).json());
  return {
    tilesById: Object.fromEntries(tiles.map((tile) => [tile.id, tile])),
    statusDefs: statusesById(await Bun.file(join(DATA, "statuses.json")).json()),
  };
}

function optionsOf(values: Parsed["values"], defaultSeeds: number): BattleOptions {
  return {
    seeds: wholeNumber(values.seeds, "--seeds", defaultSeeds, 1),
    seed: wholeNumber(values.seed, "--seed", 1),
    statuses: choice(values.statuses, "--statuses", ["on", "off"] as const, "on") === "on",
    kit: choice(values.kit, "--kit", KITS, "rolled"),
    maxSeconds: wholeNumber(values["max-seconds"], "--max-seconds", DEFAULT_MAX_SECONDS, 1),
  };
}

function sidesOf(texts: readonly string[], cat: Catalogue) {
  try {
    return {
      A: parseSide(texts[0]!, cat.tilesById),
      B: parseSide(texts[1]!, cat.tilesById),
    };
  } catch (error) {
    if (error instanceof SideError) throw new UsageError(error.message);
    throw error;
  }
}

function conditions(report: { statuses: boolean; kit: string; maxSeconds: number }): string {
  return `statuses ${report.statuses ? "on" : "off"} · kit ${report.kit} · a fight still going at ${report.maxSeconds} s is undecided`;
}

function seconds(value: number | null): string {
  return value === null ? "never" : `${value.toFixed(1)} s`;
}

function killTimes(spread: Spread | null): string {
  if (!spread) return "no kills";
  return `mean ${spread.mean.toFixed(1)} s, p50 ${spread.p50.toFixed(1)}, p95 ${spread.p95.toFixed(1)} (${spread.fights} kills)`;
}

function uptime(side: SideReport): string {
  const held = Object.entries(side.statusUptime);
  if (held.length === 0) return "none";
  return held.map(([statusId, share]) => `${statusId} ${percent(share)}`).join(", ");
}

const LOADOUTS_SHOWN = 3;

function loadoutRows(label: string, side: SideReport): string[][] {
  const shown = side.loadouts.slice(0, LOADOUTS_SHOWN);
  const more = side.loadouts.length - shown.length;
  return [
    ...shown.map(({ loadout, share }, i) => [i === 0 ? label : "", percent(share), loadout]),
    ...(more > 0 ? [["", "", `and ${more} more in --json`]] : []),
  ];
}

const HAND_RATES: (keyof HandRates)[] = ["hit", "missed", "dodged", "absorbed"];

function battleText(report: BattleReport): string {
  const { a, b, outcomes } = report;
  const setup = [
    `A  ${a.spec} (${a.name})`,
    `B  ${b.spec} (${b.name})`,
    `${report.seeds.toLocaleString("en")} seeds, each fought both ways round: ${report.fights.toLocaleString("en")} fights · ${conditions(report)}`,
  ].join("\n");

  const results = table(
    [
      ["outcome for A", "share", "95% interval"],
      ...(["wins", "losses", "draws", "undecided"] as const).map((name) => [
        name,
        percent(outcomes[name].share),
        `${percent(outcomes[name].low)} to ${percent(outcomes[name].high)}`,
      ]),
    ],
    [1],
  );

  const sides = table([
    ["", `A ${a.name}`, `B ${b.name}`],
    ["time to kill, in fights won", killTimes(a.timeToKill), killTimes(b.timeToKill)],
    [
      "  closed form, hp / dps",
      seconds(a.closedForm.secondsToKill),
      seconds(b.closedForm.secondsToKill),
    ],
    [
      "damage per second",
      `${a.damagePerSecond.sampled.toFixed(2)} (statuses ${a.damagePerSecond.statuses.toFixed(2)})`,
      `${b.damagePerSecond.sampled.toFixed(2)} (statuses ${b.damagePerSecond.statuses.toFixed(2)})`,
    ],
    [
      "  closed form",
      a.closedForm.damagePerSecond.toFixed(2),
      b.closedForm.damagePerSecond.toFixed(2),
    ],
    ["status uptime", uptime(a), uptime(b)],
  ]);

  const hands = table(
    [
      ["per hand, sampled (closed form)", "swings", ...HAND_RATES],
      ...report.hands.map((hand) => [
        hand.key,
        hand.swings.toLocaleString("en"),
        ...HAND_RATES.map(
          (name) => `${percent(hand.sampled[name])} (${percent(hand.closedForm[name])})`,
        ),
      ]),
    ],
    [1],
  );

  const worn = table([...loadoutRows(`A ${a.name}`, a), ...loadoutRows(`B ${b.name}`, b)], [1]);

  return [setup, results, sides, hands, `loadouts (kit ${report.kit})\n${worn}`].join("\n\n");
}

function traceRow(event: TraceEvent, trace: TraceReport): string[] {
  const hp = (subject: Subject, left: number) =>
    `${subject} ${left}/${(subject === "A" ? trace.a : trace.b).maxHp}`;
  const at = event.atSeconds.toFixed(2);
  if (event.kind === "swing") {
    const worth = `(worth ${event.worth})`;
    const what = {
      hit: `hits for ${event.damage} ${worth}`,
      missed: "misses",
      dodged: `is dodged ${worth}`,
      absorbed: `is absorbed ${worth}`,
    }[event.outcome];
    const inflicts = event.inflicts.length > 0 ? `, inflicts ${event.inflicts.join(", ")}` : "";
    return [at, event.by, event.hand, `${what}${inflicts}`, hp(event.target, event.hpLeft)];
  }
  if (event.kind === "ailment") {
    const what = event.hp < 0 ? `takes ${-event.hp}` : `heals ${event.hp}`;
    return [at, event.on, event.statusId, what, hp(event.on, event.hpLeft)];
  }
  if (event.kind === "statuses") {
    const changes = [
      ...(event.gained.length > 0 ? [`gains ${event.gained.join(", ")}`] : []),
      ...(event.lost.length > 0 ? [`loses ${event.lost.join(", ")}`] : []),
    ];
    return [at, event.on, "statuses", changes.join("; "), ""];
  }
  return [at, event.on, "", "falls", ""];
}

function traceText(trace: TraceReport): string {
  const setup = [
    `A  ${trace.a.spec} (${trace.a.name}) · ${trace.a.maxHp} hp · ${trace.a.loadout}`,
    `B  ${trace.b.spec} (${trace.b.name}) · ${trace.b.maxHp} hp · ${trace.b.loadout}`,
    `A is side a of the Duel, whose blow is rolled first on a shared tick · ${conditions(trace)}`,
  ].join("\n");
  const blows = table(
    [
      ["time (s)", "side", "hand or status", "what happens", "hp left"],
      ...trace.events.map((event) => traceRow(event, trace)),
    ],
    [0],
  );
  const name = (subject: Subject) => `${subject} (${(subject === "A" ? trace.a : trace.b).name})`;
  const end = {
    A: `${name("A")} wins in ${trace.seconds.toFixed(1)} s.`,
    B: `${name("B")} wins in ${trace.seconds.toFixed(1)} s.`,
    draw: `Both fall at ${trace.seconds.toFixed(1)} s: a draw.`,
    undecided: `Nobody has fallen at ${trace.maxSeconds} s: undecided.`,
  }[trace.end];
  return [setup, blows, end].join("\n\n");
}

export const battle: Command = {
  name: "battle",
  summary:
    "fight two sides through the Arena's Duel over many seeds: who wins, how often, how fast",
  usage: "bun run verify battle <a> <b> [options]",
  options: {
    seeds: { type: "string" },
    seed: { type: "string" },
    statuses: { type: "string" },
    kit: { type: "string" },
    "max-seconds": { type: "string" },
    trace: { type: "string" },
  },
  help: [
    [
      "<a> <b>",
      "a battler tile id, or one with masteries and equipment by slot, such as player:sharp=15,weapon=knights-sword (none empties a slot)",
    ],
    ["--seeds <n>", `seeds to fight, each both ways round (default ${DEFAULT_SEEDS})`],
    ["--seed <s>", "the first seed (default 1)"],
    ["--statuses on|off", "apply the status catalogue, as the world and the Arena do (default on)"],
    [
      "--kit rolled|none",
      "roll each body's kit per seed, as the world does, or carry only what is named, as the Arena does (default rolled)",
    ],
    [
      "--max-seconds <n>",
      `a fight still going after this long counts as undecided (default ${DEFAULT_MAX_SECONDS})`,
    ],
    [
      "--trace <seed>",
      "print one fight blow by blow instead: who swung with which hand, the outcome, the damage, the hp left, and statuses gained and lost (the combat status is left out)",
    ],
    ["--json", "print one JSON object instead of the tables"],
  ],
  async run({ values, positionals }): Promise<Outcome> {
    if (positionals.length !== 2) {
      throw new UsageError(`battle takes two sides, and was given ${positionals.length}.`);
    }
    if (values.trace !== undefined && (values.seed !== undefined || values.seeds !== undefined)) {
      throw new UsageError(
        "--trace takes the seed of the one fight it prints; drop --seed and --seeds.",
      );
    }
    const cat = await catalogue();
    const sides = sidesOf(positionals, cat);

    if (values.trace !== undefined) {
      const seed = wholeNumber(values.trace, "--trace", 1);
      const trace = traceBattle(sides, cat, { ...optionsOf(values, 1), seed });
      return { exitCode: 0, seed, json: { trace }, text: traceText(trace) };
    }

    const options = optionsOf(values, DEFAULT_SEEDS);
    const report = runBattle(sides, cat, options);
    return { exitCode: 0, seed: options.seed, json: { ...report }, text: battleText(report) };
  },
};
