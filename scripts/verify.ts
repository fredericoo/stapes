import { join } from "node:path";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { type Command, commitOf, describeCommit, type Outcome, UsageError } from "./verify/cli";
import { battle } from "./verify/battle";
import { content } from "./verify/content";

const ROOT = join(import.meta.dir, "..");

const COMMANDS: readonly Command[] = [content, battle];

const COMMON_OPTIONS: ParseArgsOptionsConfig = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

function overview(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  return [
    "Usage: bun run verify <command> [options]",
    "",
    "Runs the game's own code on this checkout and prints what it found, as evidence that a",
    "change does what its PR says. Nothing here is a CI gate and nothing needs a server.",
    "",
    "Commands:",
    ...COMMANDS.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
    "",
    "`bun run verify <command> --help` lists a command's options. Every command prints the",
    "commit it ran on, and takes --json to print exactly one JSON object on stdout instead.",
  ].join("\n");
}

function helpFor(command: Command): string {
  const options: [string, string][] = [...command.help, ["--help", "print this and exit"]];
  const width = Math.max(...options.map(([flag]) => flag.length));
  return [
    `Usage: ${command.usage}`,
    "",
    `${command.summary.charAt(0).toUpperCase()}${command.summary.slice(1)}.`,
    "",
    "Options:",
    ...options.map(([flag, text]) => `  ${flag.padEnd(width)}  ${text}`),
  ].join("\n");
}

function usageFailure(message: string, json: boolean, command: Command | null): number {
  if (json)
    console.log(JSON.stringify({ command: command?.name ?? null, error: message }, null, 2));
  else console.error(`${message}\n\n${command ? helpFor(command) : overview()}`);
  return 2;
}

function print(command: Command, outcome: Outcome, json: boolean) {
  const commit = commitOf(ROOT);
  if (json) {
    const envelope = {
      command: command.name,
      commit: commit.sha,
      dirty: commit.dirty,
      seed: outcome.seed,
      ...outcome.json,
    };
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }
  const seed = outcome.seed === null ? "" : ` · seed ${outcome.seed}`;
  console.log(`verify ${command.name} · ${describeCommit(commit)}${seed}\n\n${outcome.text}`);
}

async function main(argv: readonly string[]): Promise<number> {
  const json = argv.includes("--json");
  const [name, ...rest] = argv;
  if (name === undefined || name === "--help" || name === "-h" || name === "help") {
    console.log(overview());
    return name === undefined ? 2 : 0;
  }
  const command = COMMANDS.find((candidate) => candidate.name === name);
  if (!command) return usageFailure(`Unknown command "${name}".`, json, null);

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...COMMON_OPTIONS, ...command.options },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usageFailure(error instanceof Error ? error.message : String(error), json, command);
  }
  if (parsed.values.help) {
    console.log(helpFor(command));
    return 0;
  }

  try {
    const outcome = await command.run({
      values: parsed.values as Record<string, string | boolean | undefined>,
      positionals: parsed.positionals,
    });
    print(command, outcome, json);
    return outcome.exitCode;
  } catch (error) {
    if (error instanceof UsageError) return usageFailure(error.message, json, command);
    throw error;
  }
}

process.exit(await main(process.argv.slice(2)));
