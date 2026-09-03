import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientBundle } from "./clientBundle";
import { untar } from "./untar";
import { readConfig } from "./config";

/**
 * The client, as it lives on the box.
 *
 * The property that matters most here is the one that is easiest to break by
 * accident: **deploying the server must not take the client down with it.**
 * Builds live on the mounted volume rather than in the image, so a new container
 * still has the files — but only if it also remembers which of them it was
 * serving, and that is a pointer somebody could reasonably think is redundant.
 */

let dir: string;
let bundle: ClientBundle;

function configFor(dataDir: string) {
  return readConfig({ DATA_DIR: dataDir } as NodeJS.ProcessEnv);
}

function build(marker: string): Map<string, Uint8Array> {
  const encode = (text: string) => new TextEncoder().encode(text);
  return new Map([
    ["index.html", encode(`<!doctype html><title>${marker}</title>`)],
    [`assets/app-${marker}.js`, encode(`console.log("${marker}")`)],
  ]);
}

async function text(response: Response | null): Promise<string> {
  return response ? await response.text() : "";
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "stapes-client-"));
  bundle = new ClientBundle(configFor(dir));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("serving a build", () => {
  it("serves nothing until one is activated", async () => {
    await bundle.store("aaa", build("aaa"));
    // Stored is not live. An upload that half-finished must never become the
    // page, which is the whole reason these are two steps.
    expect(bundle.respond("/")).toBeNull();

    await bundle.activate("aaa");
    expect(await text(bundle.respond("/"))).toContain("aaa");
  });

  it("falls through to index.html, because routes are not files", async () => {
    await bundle.store("aaa", build("aaa"));
    await bundle.activate("aaa");
    expect(await text(bundle.respond("/map"))).toContain("aaa");
  });

  it("caches hashed assets forever and index.html never", async () => {
    // The pair is what makes a deploy visible at all: the entry point has to be
    // re-fetched, and everything it names is content-addressed.
    await bundle.store("aaa", build("aaa"));
    await bundle.activate("aaa");

    expect(bundle.respond("/")!.headers.get("Cache-Control")).toBe("no-store");
    expect(
      bundle.respond("/assets/app-aaa.js")!.headers.get("Cache-Control"),
    ).toBe("public, max-age=31536000, immutable");
  });

  it("keeps serving an older build's assets to tabs still on it", async () => {
    // Somebody loaded the page five minutes ago and their browser is still
    // asking for that build's chunks. Serving only the active build 404s them
    // into a white screen mid-session.
    await bundle.store("aaa", build("aaa"));
    await bundle.activate("aaa");
    await bundle.store("bbb", build("bbb"));
    await bundle.activate("bbb");

    expect(await text(bundle.respond("/"))).toContain("bbb");
    expect(await text(bundle.respond("/assets/app-aaa.js"))).toContain("aaa");
  });
});

describe("across a server deploy", () => {
  it("comes back up serving the same build", async () => {
    // The concern this exists for: a new container is a new process with an
    // empty memory, and if it did not write down what it was serving it would
    // come back with every file present and no page.
    await bundle.store("aaa", build("aaa"));
    await bundle.activate("aaa");

    const replacement = new ClientBundle(configFor(dir));
    await replacement.restore();

    expect(replacement.active).toBe("aaa");
    expect(await text(replacement.respond("/"))).toContain("aaa");
  });

  it("does not lose the client when CLIENT_BUILD_ID is stale", async () => {
    // The environment variable names the *first* build a box ever served and is
    // then never updated, so a restart that trusted it would roll every
    // subsequent client deploy back.
    await bundle.store("aaa", build("aaa"));
    await bundle.activate("aaa");
    await bundle.store("bbb", build("bbb"));
    await bundle.activate("bbb");

    const replacement = new ClientBundle(configFor(dir));
    await replacement.restore("aaa");

    expect(replacement.active).toBe("bbb");
  });

  it("serves the newest build when the pointer is missing", async () => {
    await bundle.store("aaa", build("aaa"));
    await bundle.activate("aaa");
    await rm(join(dir, "clients", "active"));

    const replacement = new ClientBundle(configFor(dir));
    await replacement.restore();

    expect(replacement.active).toBe("aaa");
  });

  it("comes up on nothing rather than throwing when there is no client yet", async () => {
    // The very first deploy, before continuous integration has uploaded
    // anything. A server that refused to start here would be a chicken and egg.
    const fresh = new ClientBundle(configFor(dir));
    await fresh.restore();
    expect(fresh.active).toBeNull();
  });
});

describe("housekeeping", () => {
  /**
   * Stamp a build's write time, because the clock is too coarse to test with.
   *
   * Six builds stored in a row land in the same millisecond or two, and what
   * this section is about is ordering *by time* — so the times are stated
   * rather than raced for.
   */
  async function writtenAt(id: string, secondsApart: number) {
    const when = new Date(EPOCH_MS + secondsApart * 1000);
    await utimes(join(dir, "clients", id), when, when);
  }

  it("does not delete a build that is uploaded but not yet activated", async () => {
    // The shape of a production deploy, and the bug that killed three of them.
    // Continuous integration uploads, restarts the server, and only *then*
    // activates — so the restart collects garbage while the new build is on
    // disk and nothing points at it yet. Build ids are commit shas, so keeping
    // "the last five by name" kept five arbitrary builds and threw away the one
    // the deploy was seconds from serving.
    const alreadyDeployed = ["ff", "ee", "dd", "cc", "bb"];
    for (const [index, id] of alreadyDeployed.entries()) {
      await bundle.store(id, build(id));
      await writtenAt(id, index);
      await bundle.activate(id);
    }

    await bundle.store("aa", build("aa"));
    await writtenAt("aa", alreadyDeployed.length);

    const replacement = new ClientBundle(configFor(dir));
    await replacement.restore();
    await replacement.activate("aa");

    expect(await text(replacement.respond("/"))).toContain("aa");
  });

  it("deletes builds nobody is on", async () => {
    // The volume is shared with the world, and a full disk stops it
    // checkpointing — so this is not optional tidying.
    for (const id of ["b1", "b2", "b3", "b4", "b5", "b6", "b7"]) {
      await bundle.store(id, build(id));
      await bundle.activate(id);
    }
    const left = (await readdir(join(dir, "clients"))).filter(
      (n) => n !== "active",
    );
    expect(left.length).toBeLessThanOrEqual(5);
    expect(left).toContain("b7");
  });
});

/** An arbitrary fixed instant, so stamped write times are reproducible. */
const EPOCH_MS = Date.UTC(2026, 0, 1);

describe("untar", () => {
  it("reads what tar writes", async () => {
    const source = await mkdtemp(join(tmpdir(), "stapes-tar-"));
    await Bun.write(join(source, "index.html"), "<title>hi</title>");
    await Bun.write(join(source, "assets/app.js"), "console.log(1)");
    // `COPYFILE_DISABLE` because macOS `tar` otherwise adds an AppleDouble
    // `._name` beside every entry, which is a fact about this laptop rather
    // than about the archives continuous integration produces on Linux.
    await Bun.$`COPYFILE_DISABLE=1 tar -cf ${join(source, "b.tar")} -C ${source} index.html assets`.quiet();

    const files = untar(
      new Uint8Array(await Bun.file(join(source, "b.tar")).arrayBuffer()),
    );

    expect([...files.keys()].sort()).toEqual(["assets/app.js", "index.html"]);
    expect(new TextDecoder().decode(files.get("index.html")!)).toBe(
      "<title>hi</title>",
    );
    await rm(source, { recursive: true, force: true });
  });

  it("drops entries that would escape the directory", () => {
    // An archive is untrusted input even when we produced it, and a path with
    // `..` in it is the way one writes outside where it is unpacked.
    const header = new Uint8Array(512);
    const name = "../../etc/passwd";
    new TextEncoder().encodeInto(name, header.subarray(0, 100));
    new TextEncoder().encodeInto("00000000004\0", header.subarray(124, 136));
    header[156] = "0".charCodeAt(0);
    const archive = new Uint8Array(1024);
    archive.set(header);
    archive.set(new TextEncoder().encode("evil"), 512);

    expect(untar(archive).size).toBe(0);
  });
});
