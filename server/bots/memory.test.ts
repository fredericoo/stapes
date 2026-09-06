import { describe, expect, it } from "bun:test";
import { BotMemory, REMEMBERED_ENTRIES } from "./memory";
import type { BotCall } from "./tools";

/**
 * What a bot carries between decisions.
 *
 * Pure, and against nothing but its own two write methods: no world, no
 * provider, no map. The one case that needs a real world — that what this
 * renders actually reaches the prompt — lives in `./runner.test.ts`, because
 * that is a claim about the runner rather than about this.
 *
 * The clock is passed in, so every case here says exactly what time each line
 * was written at. That is the same thing `BotRunner.decideOnce` does with
 * `BotBody.minutesOfDay`, and it is why the stamps can be asserted at all.
 */

/** A quarter past six in the morning, as the world counts minutes. */
const SIX_FIFTEEN = 6 * 60 + 15;

/** One decision, in the order the runner takes it. */
function turn(
  memory: BotMemory,
  atMinutes: number,
  events: string[],
  calls: BotCall[],
) {
  memory.observed(events, atMinutes);
  memory.decided(calls, atMinutes);
}

const SAY_ANTEATER: BotCall = {
  tool: "say",
  text: "What are you doing here, Ivory Anteater?",
};

describe("the log", () => {
  it("keeps what the bot said long after the event log dropped it", () => {
    // The live bug: the body drains its log, so `You said: ...` is shown in the
    // next decision and then gone. Three decisions later the bot asked the same
    // question again, at a person who had not had time to answer.
    const memory = new BotMemory();

    turn(memory, SIX_FIFTEEN, [], [SAY_ANTEATER]);
    turn(
      memory,
      SIX_FIFTEEN + 1,
      ["You said: What are you doing here, Ivory Anteater?"],
      [],
    );
    turn(memory, SIX_FIFTEEN + 2, [], [{ tool: "step", direction: "n" }]);
    turn(memory, SIX_FIFTEEN + 3, ["You stepped n."], []);

    expect(memory.render()).toContain("Ivory Anteater?");
  });

  it("keeps an utterance for far longer than the decision that made it", () => {
    // The measurement the bug is really about. A minute of ordinary play is
    // several decisions, and what the bot said at the start of it is still
    // there at the end.
    const memory = new BotMemory();

    turn(memory, SIX_FIFTEEN, [], [SAY_ANTEATER]);
    for (let minute = 1; minute <= 8; minute++) {
      turn(
        memory,
        SIX_FIFTEEN + minute,
        ["You stepped n."],
        [{ tool: "step", direction: "n" }],
      );
    }

    expect(memory.render()).toContain("Ivory Anteater?");
  });

  it("reads oldest first, whatever order the two writes came in", () => {
    const memory = new BotMemory();

    turn(memory, SIX_FIFTEEN, [], [{ tool: "say", text: "first" }]);
    turn(memory, SIX_FIFTEEN + 1, ["Deer said: second"], []);
    turn(memory, SIX_FIFTEEN + 2, [], [{ tool: "say", text: "third" }]);

    const rendered = memory.render();
    expect(rendered.indexOf("first")).toBeLessThan(rendered.indexOf("second"));
    expect(rendered.indexOf("second")).toBeLessThan(rendered.indexOf("third"));
    // And the stamps climb with them, rather than all reading the same minute.
    expect(rendered).toContain("06:15  You said: first");
    expect(rendered).toContain("06:16  Deer said: second");
    expect(rendered).toContain("06:17  You said: third");
  });

  it("stamps a line with the time it was written, not the time it is read", () => {
    const memory = new BotMemory();

    memory.decided([{ tool: "say", text: "early" }], SIX_FIFTEEN);
    memory.observed(["Deer said: late"], SIX_FIFTEEN + 30);

    // Rendered together, long after both, and each keeps its own hour.
    expect(memory.render()).toContain("06:15  You said: early");
    expect(memory.render()).toContain("06:45  Deer said: late");
  });

  it("says the same sentence once, however many places it arrived from", () => {
    // `body.apply` pushes `describeCall`'s line into the event log, so every
    // action echoes back as an event on the drain after the decision that
    // already wrote it down.
    const memory = new BotMemory();

    memory.decided([SAY_ANTEATER], SIX_FIFTEEN);
    memory.observed(
      [
        "You said: What are you doing here, Ivory Anteater?",
        "Ivory Anteater said: I live here.",
      ],
      SIX_FIFTEEN + 1,
    );

    const rendered = memory.render();
    expect(rendered.split("Ivory Anteater?")).toHaveLength(2);
    expect(rendered).toContain("Ivory Anteater said: I live here.");
  });

  it("keeps the last twenty lines and drops the oldest", () => {
    const memory = new BotMemory();

    // Padded, so "line 2" is not also found inside "line 22".
    const said = (i: number) => `line ${String(i).padStart(2, "0")}`;
    for (let i = 0; i < REMEMBERED_ENTRIES + 3; i++) {
      turn(memory, SIX_FIFTEEN + i, [], [{ tool: "say", text: said(i) }]);
    }

    const rendered = memory.render();
    expect(rendered).not.toContain(said(0));
    expect(rendered).not.toContain(said(2));
    expect(rendered).toContain(said(3));
    expect(rendered).toContain(said(REMEMBERED_ENTRIES + 2));
    expect(rendered.match(/^\d\d:\d\d {2}/gm)).toHaveLength(REMEMBERED_ENTRIES);
  });

  it("counts lines rather than decisions, so a busy one costs more", () => {
    // Three calls in one decision is three lines of the twenty, not one.
    const memory = new BotMemory();

    for (let i = 0; i < 7; i++) {
      turn(
        memory,
        SIX_FIFTEEN + i,
        [],
        [
          { tool: "say", text: `a${i}` },
          { tool: "say", text: `b${i}` },
          { tool: "say", text: `c${i}` },
        ],
      );
    }

    expect(memory.render()).not.toContain("a0");
    expect(memory.render()).toContain("c6");
  });

  it("bounds one drain, so a fight cannot push out what the bot said", () => {
    const memory = new BotMemory();

    turn(memory, SIX_FIFTEEN, [], [SAY_ANTEATER]);
    memory.observed(
      Array.from({ length: 40 }, (_, i) => `You took ${i} damage.`),
      SIX_FIFTEEN + 1,
    );

    const kept = memory.render().match(/You took \d+ damage\./g) ?? [];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(REMEMBERED_ENTRIES);
    expect(memory.render()).toContain("Ivory Anteater?");
  });

  it("does not clip an ordinary sentence", () => {
    const memory = new BotMemory();
    const said = `Ivory Anteater said: ${"word ".repeat(40).trim()}`;

    memory.observed([said], SIX_FIFTEEN);

    expect(memory.render()).toContain(said);
  });

  it("bounds one enormous sentence rather than letting it crowd the rest", () => {
    const memory = new BotMemory();

    memory.observed([`Somebody said: ${"a".repeat(5_000)}`], SIX_FIFTEEN);
    turn(memory, SIX_FIFTEEN + 1, [], [{ tool: "step", direction: "s" }]);

    expect(memory.render().length).toBeLessThan(1_000);
    expect(memory.render()).toContain("Somebody said:");
    expect(memory.render()).toContain("You stepped s.");
  });

  it("stays under its budget however busy the minute was", () => {
    const quiet = new BotMemory();
    const busy = new BotMemory();
    for (let i = 0; i < REMEMBERED_ENTRIES; i++) {
      turn(
        quiet,
        SIX_FIFTEEN + i,
        ["You stepped n."],
        [{ tool: "step", direction: "n" }],
      );
      turn(
        busy,
        SIX_FIFTEEN + i,
        Array.from({ length: 20 }, () => "Somebody said: ".padEnd(400, "a")),
        [{ tool: "say", text: "x".padEnd(250, "x") }],
      );
    }

    expect(quiet.render().length).toBeLessThan(1_500);
    expect(busy.render().length).toBeLessThan(3_500);
    // And the newest line is the one that survives the cut.
    expect(busy.render().split("\n").at(-1)).toContain("You said: xx");
  });

  it("keeps what arrived before the bot had done anything", () => {
    const memory = new BotMemory();

    memory.observed(["You have arrived somewhere new."], SIX_FIFTEEN);

    expect(memory.render()).toContain("You have arrived somewhere new.");
  });

  it("is only a goal when nothing has happened yet", () => {
    expect(new BotMemory().render()).not.toContain("What has happened");
  });
});

describe("the goal", () => {
  it("survives decisions it was not mentioned in", () => {
    const memory = new BotMemory();

    memory.decided([{ tool: "set_goal", text: "find the shop" }], SIX_FIFTEEN);
    for (let i = 1; i <= REMEMBERED_ENTRIES + 3; i++) {
      turn(
        memory,
        SIX_FIFTEEN + i,
        ["You stepped n."],
        [{ tool: "step", direction: "n" }],
      );
    }

    // Long enough that the line announcing the goal has fallen off the log.
    expect(memory.render()).not.toContain("You set your goal");
    expect(memory.currentGoal()).toBe("find the shop");
    expect(memory.render()).toContain("find the shop");
  });

  it("is replaced by the next one, and only by that", () => {
    const memory = new BotMemory();

    memory.decided([{ tool: "set_goal", text: "find the shop" }], SIX_FIFTEEN);
    memory.decided([{ tool: "say", text: "hello" }], SIX_FIFTEEN + 1);
    expect(memory.currentGoal()).toBe("find the shop");

    memory.decided([{ tool: "set_goal", text: "go home" }], SIX_FIFTEEN + 2);
    expect(memory.currentGoal()).toBe("go home");
    expect(memory.render()).not.toContain("## Your goal\nfind the shop");
  });

  it("asks for one while there is none", () => {
    const memory = new BotMemory();

    expect(memory.currentGoal()).toBeNull();
    expect(memory.render()).toContain("set_goal");
  });
});
