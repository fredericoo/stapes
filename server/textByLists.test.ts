import { describe, expect, it } from "bun:test";
import { TextByLists } from "./textByLists";

function writer(text: string) {
  const write = () => {
    write.calls++;
    return text;
  };
  write.calls = 0;
  return write;
}

describe("TextByLists", () => {
  it("writes the text once for lists that are equal, whichever arrays hold them", () => {
    const memo = new TextByLists();
    const first = writer("first");
    const second = writer("second");

    expect(memo.textFor([[1, 2], [3]], first)).toBe("first");
    expect(memo.textFor([[1, 2], [3]], second)).toBe("first");
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(0);
  });

  it("keeps lists apart that hold the same numbers split differently", () => {
    const memo = new TextByLists();

    expect(memo.textFor([[1, 2], [3]], writer("split after two"))).toBe("split after two");
    expect(memo.textFor([[1], [2, 3]], writer("split after one"))).toBe("split after one");
    expect(memo.textFor([[1, 2, 3], []], writer("one list"))).toBe("one list");
  });

  /** `[5, 0]` and `[6, -31]` hash alike: `(h·31 + 5)·31 + 0` and `(h·31 + 6)·31 − 31` are equal. */
  it("keeps lists apart that hash alike, and finds each again", () => {
    const memo = new TextByLists();

    expect(memo.textFor([[5, 0]], writer("five"))).toBe("five");
    expect(memo.textFor([[6, -31]], writer("six"))).toBe("six");
    expect(memo.textFor([[5, 0]], writer("again"))).toBe("five");
    expect(memo.textFor([[6, -31]], writer("again"))).toBe("six");
  });
});
