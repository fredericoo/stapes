import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { openDatabase } from "./db";
import { openWorldDatabaseExclusively } from "./lock";

/**
 * The single-writer guarantee.
 *
 * This is the one thing the Durable Object provided that a virtual machine does
 * not, and its absence does not announce itself: two processes both simulating
 * one world write a board blended from two timelines, which then persists
 * because the checkpoint is preferred over the authored map on load.
 *
 * **These tests spawn real processes, and they have to.** POSIX advisory locks
 * are held per *process*, so a second connection opened inside this one does
 * not conflict with the first — an in-process test would report a guarantee
 * that does not exist. The failure mode being guarded is two containers, so the
 * test is two processes.
 */

const temporaries: string[] = [];
const children: ChildProcess[] = [];

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stapes-lock-"));
  temporaries.push(dir);
  return dir;
}

/**
 * A separate process holding the database open, exclusively.
 *
 * Resolves once it reports that it has the lock, so the assertions that follow
 * are not racing its startup.
 */
function holdInSubprocess(path: string): Promise<ChildProcess> {
  const source = `
    const { openWorldDatabaseExclusively } = await import(${JSON.stringify(
      new URL("./lock.ts", import.meta.url).href,
    )});
    await openWorldDatabaseExclusively(${JSON.stringify(path)});
    console.log("HELD");
    await new Promise(() => {});
  `;
  const child = spawn("bun", ["-e", source], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("holder never started")),
      15_000,
    );
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
  await Promise.all(
    temporaries
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("exclusive world database", () => {
  it("refuses a second process while the first holds it", async () => {
    const path = join(await scratchDir(), "stapes.db");
    await holdInSubprocess(path);

    await expect(
      openWorldDatabaseExclusively(path, { attempts: 2, delayMs: 50 }),
    ).rejects.toThrow(/Refusing to start a second writer/);
  }, 30_000);

  it("takes the lock at open, not at the first write", async () => {
    // The failure this guards was real while writing this code: the pragma only
    // takes effect on a connection's first write, so on an already-migrated
    // database two processes would both boot, both load a world, and only
    // diverge visibly at the first checkpoint two seconds later. Migrating
    // first, so the holder has no migration write to take the lock for, is
    // exactly that case.
    const path = join(await scratchDir(), "stapes.db");
    const migrated = await openDatabase(path);
    await migrated.close?.();

    await holdInSubprocess(path);

    await expect(
      openWorldDatabaseExclusively(path, { attempts: 2, delayMs: 50 }),
    ).rejects.toThrow(/Refusing to start a second writer/);
  }, 30_000);

  it("lets a successor in once the holder has gone", async () => {
    // A deploy is exactly this, and a lock that outlived its process would wedge
    // every future one.
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
    // Retrying a corrupt file for the full window turns a clear error into a
    // slow one, and the message that would have explained it arrives last.
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
