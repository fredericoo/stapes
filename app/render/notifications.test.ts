import { describe, expect, it } from "vitest";
import { MAX_NOTICES, NOTICE_LIFETIME_MS, NoticeQueue } from "./notifications";

/**
 * How many lines are up, and for how long.
 *
 * The queue is the whole of the behaviour — the layer below it only turns this
 * list into elements — so everything worth asserting is here.
 */

const textsOf = (queue: NoticeQueue, nowMs: number) =>
  queue.live(nowMs).map((notice) => notice.text);

describe("what is on screen", () => {
  it("holds a notice for its lifetime and not a moment longer", () => {
    const queue = new NoticeQueue();
    queue.push("Your blade mastery is now 10", 0);

    expect(textsOf(queue, NOTICE_LIFETIME_MS - 1)).toEqual([
      "Your blade mastery is now 10",
    ]);
    expect(textsOf(queue, NOTICE_LIFETIME_MS)).toEqual([]);
  });

  it("stacks the newest last, so the column grows upward from the bottom", () => {
    const queue = new NoticeQueue();
    queue.push("first", 0);
    queue.push("second", 10);

    expect(textsOf(queue, 20)).toEqual(["first", "second"]);
  });

  it("evicts the oldest rather than making a third wait its turn", () => {
    const queue = new NoticeQueue();
    queue.push("first", 0);
    queue.push("second", 10);
    queue.push("third", 20);

    expect(textsOf(queue, 30)).toEqual(["second", "third"]);
    expect(queue.live(30)).toHaveLength(MAX_NOTICES);
  });

  it("keeps an evicted notice's slot free rather than reviving it later", () => {
    const queue = new NoticeQueue();
    queue.push("first", 0);
    queue.push("second", 10);
    queue.push("third", 20);

    // "first" went at 20 and does not come back when "second" expires.
    expect(textsOf(queue, 10 + NOTICE_LIFETIME_MS)).toEqual(["third"]);
  });

  it("refreshes a repeat of the newest instead of stacking a duplicate", () => {
    const queue = new NoticeQueue();
    queue.push("You cannot fit there", 0);
    queue.push("You cannot fit there", 1_000);

    expect(textsOf(queue, 1_000)).toEqual(["You cannot fit there"]);
    // Still up a full lifetime after the *second* press, not the first.
    expect(textsOf(queue, 1_000 + NOTICE_LIFETIME_MS - 1)).toEqual([
      "You cannot fit there",
    ]);
  });

  it("puts a repeat of the older line back at the bottom", () => {
    const queue = new NoticeQueue();
    queue.push("first", 0);
    queue.push("second", 10);
    queue.push("first", 20);

    expect(textsOf(queue, 30)).toEqual(["second", "first"]);
  });

  it("gives every live notice an identity of its own", () => {
    const queue = new NoticeQueue();
    queue.push("first", 0);
    queue.push("second", 10);

    const [a, b] = queue.live(20);
    expect(a!.id).not.toBe(b!.id);
  });
});
