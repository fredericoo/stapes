import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { openDatabase } from "./db";
import { openWorldDatabaseExclusively } from "./lock";

const temporaries: string[] = [];
const children: ChildProcess[] = [];

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stapes-lock-"));
  temporaries.push(dir);
  return dir;
}

function holdInSubprocess(path: string): Promise<ChildProcess> {
  const source = `
    const { openWorldDatabaseExclusively } = await import(${JSON.stringify(
      new URL("./lock.ts", import.meta.url).href,
    )});
    await openWorldDatabaseExclusively(${JSON.stringify(path)});
    console.log("HELD");
    await new Promise(() => {});
  `;
  const child = spawn("bun", ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("holder never started")), 15_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("HELD")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`holder exited early with ${code}`));
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.on("exit", () => resolve()));
}

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("exclusive world database", () => {
  it("refuses a second process while the first holds it", async () => {
    const path = join(await scratchDir(), "stapes.db");
    await holdInSubprocess(path);

    await expect(openWorldDatabaseExclusively(path, { attempts: 2, delayMs: 50 })).rejects.toThrow(
      /Refusing to start a second writer/,
    );
  }, 30_000);

  it("takes the lock at open, not at the first write", async () => {
    const path = join(await scratchDir(), "stapes.db");
    const migrated = await openDatabase(path);
    await migrated.close?.();

    await holdInSubprocess(path);

    await expect(openWorldDatabaseExclusively(path, { attempts: 2, delayMs: 50 })).rejects.toThrow(
      /Refusing to start a second writer/,
    );
  }, 30_000);

  it("lets a successor in once the holder has gone", async () => {
    const path = join(await scratchDir(), "stapes.db");
    const holder = await holdInSubprocess(path);

    holder.kill("SIGKILL");
    await waitForExit(holder);

    const successor = await openWorldDatabaseExclusively(path);
    await successor.close?.();
  }, 30_000);

  it("propagates a broken database rather than retrying it", async () => {
    const path = join(await scratchDir(), "stapes.db");
    await writeFile(path, "this is not a database");

    const started = Date.now();
    await expect(openWorldDatabaseExclusively(path)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
