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
import { type MatrixCell, type MatrixReport, runMatrix } from "../../app/verify/matrix";
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
import { changes, changesText, runAgainst } from "./against";

const DATA = join(import.meta.dir, "../../data");

const DEFAULT_SEEDS = 1000;
const DEFAULT_MATRIX_SEEDS = 100;
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

function twoSides(texts: readonly string[], cat: Catalogue) {
  if (texts.length !== 2) {
    throw new UsageError(`battle takes two sides, and was given ${texts.length}.`);
  }
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
  const loadouts = Object.entries(side.loadouts);
  const shown = loadouts.slice(0, LOADOUTS_SHOWN);
  const more = loadouts.length - shown.length;
  return [
    ...shown.map(([loadout, share], i) => [i === 0 ? label : "", percent(share), loadout]),
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

function whole(share: number): string {
  return `${(share * 100).toFixed(0)}%`;
}

function matrixCell(cell: MatrixCell): string {
  const time = cell.timeToWin ? `${cell.timeToWin.p50.toFixed(1)} s` : "never";
  return `${whole(cell.wins.share)} [${whole(cell.wins.low)}-${whole(cell.wins.high)}] win · ${whole(cell.losses.share)} loss · ${time}`;
}

function matrixText(report: MatrixReport): string {
  const setup = [
    ...report.players.map(({ rung, spec }) => `rung ${rung}  ${spec}`),
    `${report.seeds.toLocaleString("en")} seeds a cell, each fought both ways round: ${report.fights.toLocaleString("en")} fights · ${conditions(report)}`,
  ].join("\n");
  const cells = table([
    ["creature", ...report.players.map(({ rung }) => `player at rung ${rung}`)],
    ...report.rows.map((row) => [row.key, ...row.cells.map(matrixCell)]),
  ]);
  const key =
    "Each cell: how often the player wins, with its 95% interval, how often it loses, and its median time to win. Draws and undecided fights are the rest.";
  return [setup, cells, key].join("\n\n");
}

export const battle: Command = {
  name: "battle",
  summary:
    "fight two sides through the Arena's Duel over many seeds: who wins, how often, how fast",
  usage: "bun run verify battle <a> <b> [options], or bun run verify battle --matrix [options]",
  options: {
    seeds: { type: "string" },
    seed: { type: "string" },
    statuses: { type: "string" },
    kit: { type: "string" },
    "max-seconds": { type: "string" },
    trace: { type: "string" },
    matrix: { type: "boolean" },
    against: { type: "string" },
  },
  help: [
    [
      "<a> <b>",
      "a battler tile id, or one with masteries and equipment by slot, such as player:sharp=15,weapon=knights-sword (none empties a slot)",
    ],
    [
      "--seeds <n>",
      `seeds to fight, each both ways round (default ${DEFAULT_SEEDS}, or ${DEFAULT_MATRIX_SEEDS} a cell with --matrix)`,
    ],
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
    [
      "--matrix",
      "fight every creature against a player at rungs 10, 15 and 33 (Sharp, Toughness and Agility at the rung, holding that rung's sword), as one table; takes no sides",
    ],
    [
      "--against <ref>",
      "run the same fights on another commit, such as main, in a temporary git worktree, and print the change in each figure",
    ],
    ["--json", "print one JSON object instead of the tables"],
  ],
  async run({ values, positionals }): Promise<Outcome> {
    if (values.trace !== undefined) {
      if (values.matrix || values.against !== undefined) {
        throw new UsageError("--trace prints one fight; drop --matrix and --against.");
      }
      if (values.seed !== undefined || values.seeds !== undefined) {
        throw new UsageError(
          "--trace takes the seed of the one fight it prints; drop --seed and --seeds.",
        );
      }
      const cat = await catalogue();
      const seed = wholeNumber(values.trace, "--trace", 1);
      const trace = traceBattle(twoSides(positionals, cat), cat, { ...optionsOf(values, 1), seed });
      return { exitCode: 0, seed, json: { trace }, text: traceText(trace) };
    }

    const cat = await catalogue();
    let options: BattleOptions;
    let fought: { json: Record<string, unknown>; text: string; args: string[] };
    if (values.matrix) {
      if (positionals.length > 0)
        throw new UsageError("--matrix picks its own sides; drop the sides.");
      options = optionsOf(values, DEFAULT_MATRIX_SEEDS);
      const report = runMatrix(cat, options);
      fought = { json: { ...report }, text: matrixText(report), args: ["--matrix"] };
    } else {
      options = optionsOf(values, DEFAULT_SEEDS);
      const report = runBattle(twoSides(positionals, cat), cat, options);
      fought = { json: { ...report }, text: battleText(report), args: [...positionals] };
    }

    if (typeof values.against !== "string") {
      return { exitCode: 0, seed: options.seed, json: fought.json, text: fought.text };
    }
    const baseline = runAgainst(values.against, [
      "battle",
      ...fought.args,
      ...["--seeds", String(options.seeds), "--seed", String(options.seed)],
      ...["--statuses", options.statuses ? "on" : "off", "--kit", options.kit],
      ...["--max-seconds", String(options.maxSeconds)],
    ]);
    const found = changes(baseline.report, fought.json);
    return {
      exitCode: 0,
      seed: options.seed,
      json: {
        ...fought.json,
        against: baseline,
        changes: found.changed,
        unchanged: found.unchanged,
      },
      text: `${fought.text}\n\n${changesText(baseline, found)}`,
    };
  },
};
