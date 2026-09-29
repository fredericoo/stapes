import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientBundle } from "./clientBundle";
import { readConfig } from "./config";
import { serveClient } from "./serveClient";

let dir: string;
let bundle: ClientBundle;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "stapes-serve-client-"));
  bundle = new ClientBundle(readConfig({ DATA_DIR: dir } as NodeJS.ProcessEnv));
  const encode = (text: string) => new TextEncoder().encode(text);
  await bundle.store(
    "aaa",
    new Map([
      ["index.html", encode("<!doctype html><title>aaa</title>")],
      ["home/clip.mp4", encode("0123456789")],
    ]),
  );
  await bundle.activate("aaa");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it("hands a GET's Range header to the bundle, and ignores it on a HEAD as HTTP says", async () => {
  const app = serveClient(bundle);
  const request = (method: string) =>
    new Request("http://localhost/home/clip.mp4", { method, headers: { Range: "bytes=0-1" } });

  const get = await app.handle(request("GET"));
  expect(get.status).toBe(206);
  expect(await get.text()).toBe("01");

  const head = await app.handle(request("HEAD"));
  expect(head.status).toBe(200);
});
