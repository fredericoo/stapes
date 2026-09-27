import { battlerTiles } from "../game/arena";
import { PLAYER_TILE_ID } from "../game/constants";
import { resolveBattler } from "../lib/battler";
import { type BattleOptions, type Catalogue, type Rate, runBattle, type Spread } from "./battle";
import { parseSide } from "./sides";

/**
 * The player at each rung has Sharp, Toughness and Agility at the rung and holds
 * the sword that asks for it, because the sword is the weapon every other weapon
 * on a rung is priced against (`docs/notes.md`, "Every weapon sits on one ladder").
 */
export const MATRIX_RUNGS: readonly { rung: number; sword: string }[] = [
  { rung: 10, sword: "iron-sword" },
  { rung: 15, sword: "knights-sword" },
  { rung: 33, sword: "tempered-longsword" },
];

export function playerAtRung(rung: number, sword: string): string {
  return `${PLAYER_TILE_ID}:sharp=${rung},toughness=${rung},agility=${rung},weapon=${sword}`;
}

export type MatrixCell = {
  key: string;
  rung: number;
  wins: Rate;
  losses: Rate;
  draws: Rate;
  undecided: Rate;
  timeToWin: Spread | null;
  timeToLose: Spread | null;
};

export type MatrixRow = { key: string; name: string; cells: MatrixCell[] };

export type MatrixReport = {
  seeds: number;
  fights: number;
  statuses: boolean;
  kit: BattleOptions["kit"];
  maxSeconds: number;
  players: { rung: number; spec: string }[];
  rows: MatrixRow[];
};

export function runMatrix(catalogue: Catalogue, options: BattleOptions): MatrixReport {
  const { tilesById } = catalogue;
  const players = MATRIX_RUNGS.map(({ rung, sword }) => ({
    rung,
    spec: playerAtRung(rung, sword),
  }));
  const creatures = battlerTiles(Object.values(tilesById))
    .filter((tile) => tile.id !== PLAYER_TILE_ID && resolveBattler(tile)?.pvp !== true)
    .sort((x, y) => x.id.localeCompare(y.id));

  let fights = 0;
  const rows = creatures.map((creature) => ({
    key: creature.id,
    name: creature.name,
    cells: players.map(({ rung, spec }) => {
      const sides = { A: parseSide(spec, tilesById), B: parseSide(creature.id, tilesById) };
      const report = runBattle(sides, catalogue, options);
      fights = report.fights;
      return {
        key: String(rung),
        rung,
        ...report.outcomes,
        timeToWin: report.a.timeToKill,
        timeToLose: report.b.timeToKill,
      };
    }),
  }));

  return {
    seeds: options.seeds,
    fights,
    statuses: options.statuses,
    kit: options.kit,
    maxSeconds: options.maxSeconds,
    players,
    rows,
  };
}
