import { describe, expect, it } from "vitest";
import type { CheckpointBatch, Checkpoints, StoredWorld } from "./checkpoints";
import { LocalStore } from "./LocalStore";

function recording(): Checkpoints & { world: StoredWorld; commits: number } {
  const state = {
    world: { values: new Map<string, string>(), alarmAtMs: null } as StoredWorld,
    commits: 0,
    load: () =>
      Promise.resolve({
        values: new Map(state.world.values),
        alarmAtMs: state.world.alarmAtMs,
      }),
    commit: (batch: CheckpointBatch) => {
      state.commits += 1;
      for (const [key, value] of batch.writes) state.world.values.set(key, value);
      for (const key of batch.deletions) state.world.values.delete(key);
      if (batch.alarmAtMs !== undefined) state.world.alarmAtMs = batch.alarmAtMs;
      return Promise.resolve();
    },
    clear: () => {
      state.world = { values: new Map(), alarmAtMs: null };
      return Promise.resolve();
    },
  };
  return state;
}

describe("LocalStore", () => {
  it("reads back what it was given", async () => {
    const store = new LocalStore();
    await store.put("actor:alice", { x: 3, y: 4 });

    expect(await store.get("actor:alice")).toEqual({ x: 3, y: 4 });
    expect(await store.get("actor:nobody")).toBeUndefined();
  });

  it("takes a batch of keys at once", async () => {
    const store = new LocalStore();
    await store.put({ "actor:alice": 1, "actor:bob": 2 });

    expect(await store.get("actor:bob")).toBe(2);
  });

  it("keeps the value as it was written, not as it became", async () => {
    const store = new LocalStore();
    const stack = [{ tileId: "grass" }];
    await store.put("chunk:0", stack);

    stack.push({ tileId: "wall" });

    expect(await store.get("chunk:0")).toEqual([{ tileId: "grass" }]);
  });

  it("lists a prefix in key order", async () => {
    const store = new LocalStore();
    await store.put("actor:carol", 3);
    await store.put("actor:alice", 1);
    await store.put("chunk:0", "elsewhere");

    const listed = await store.list({ prefix: "actor:" });

    expect([...listed.keys()]).toEqual(["actor:alice", "actor:carol"]);
  });

  it("stops listing what has been deleted", async () => {
    const store = new LocalStore();
    await store.put("actor:alice", 1);
    await store.put("actor:bob", 2);

    expect(await store.delete("actor:alice")).toBe(true);
    expect(await store.delete("actor:nobody")).toBe(false);
    expect([...(await store.list({ prefix: "actor:" })).keys()]).toEqual(["actor:bob"]);
  });

  it("counts a batch delete", async () => {
    const store = new LocalStore();
    await store.put({ a: 1, b: 2 });

    expect(await store.delete(["a", "b", "never-was"])).toBe(2);
  });

  describe("checkpointing", () => {
    it("writes down only what moved", async () => {
      const checkpoints = recording();
      const store = new LocalStore(checkpoints);

      expect(store.dirty).toBe(false);
      await store.put("actor:alice", { x: 1 });
      expect(store.dirty).toBe(true);
      await store.flush();
      expect(store.dirty).toBe(false);
      expect(checkpoints.commits).toBe(1);

      await store.flush();
      expect(checkpoints.commits).toBe(1);
    });

    it("brings the world back", async () => {
      const checkpoints = recording();
      const before = new LocalStore(checkpoints);
      await before.put("actor:alice", { x: 1 });
      await before.setAlarm(1234);
      await before.flush();

      const after = new LocalStore(checkpoints);
      await after.restore();

      expect(await after.get("actor:alice")).toEqual({ x: 1 });
      expect(after.alarmAt()).toBe(1234);
    });

    it("carries a deletion across a restart", async () => {
      const checkpoints = recording();
      const before = new LocalStore(checkpoints);
      await before.put("actor:alice", { x: 1 });
      await before.flush();
      await before.delete("actor:alice");
      await before.flush();

      const after = new LocalStore(checkpoints);
      await after.restore();

      expect(await after.get("actor:alice")).toBeUndefined();
    });

    it("empties the stored world when everything goes", async () => {
      const checkpoints = recording();
      const store = new LocalStore(checkpoints);
      await store.put("actor:alice", { x: 1 });
      await store.flush();

      await store.deleteAll();

      expect(checkpoints.world.values.size).toBe(0);
      expect(await store.get("actor:alice")).toBeUndefined();
      expect(store.dirty).toBe(false);
    });
  });

  describe("the alarm", () => {
    it("tells the scheduler whenever it moves", async () => {
      const store = new LocalStore();
      const seen: (number | null)[] = [];
      store.onAlarmChange = (atMs) => seen.push(atMs);

      await store.setAlarm(500);
      await store.deleteAlarm();

      expect(seen).toEqual([500, null]);
      expect(store.alarmAt()).toBeNull();
    });

    it("writes down that it was cleared, not just that it was set", async () => {
      const checkpoints = recording();
      const store = new LocalStore(checkpoints);
      await store.setAlarm(500);
      await store.flush();
      await store.deleteAlarm();
      await store.flush();

      const after = new LocalStore(checkpoints);
      await after.restore();

      expect(after.alarmAt()).toBeNull();
    });
  });
});
