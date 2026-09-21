import { afterEach, describe, expect, it } from "vitest";
import { haptic, hasHaptics } from "./haptics";

/**
 * There is no window under vitest's node environment, which is the case the
 * bridge has to survive first: every one of these functions is called from
 * `RemoteSession`, and that runs in the suite as much as in a tab.
 */
function withWindow(shape: Record<string, unknown>): void {
  (globalThis as { window?: unknown }).window = shape;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("the haptic bridge", () => {
  it("does nothing at all in a plain tab", () => {
    withWindow({});
    expect(hasHaptics()).toBe(false);
    expect(() => haptic("hit", 1)).not.toThrow();
  });

  it("does nothing where there is no window", () => {
    expect(hasHaptics()).toBe(false);
    expect(() => haptic("hit", 1)).not.toThrow();
  });

  it("posts to the WebKit message handler when one is installed", () => {
    const posted: unknown[] = [];
    withWindow({
      webkit: { messageHandlers: { stapesHaptics: { postMessage: (b: unknown) => posted.push(b) } } },
    });

    expect(hasHaptics()).toBe(true);
    haptic("hit", 0.25);

    expect(posted).toEqual([{ kind: "hit", intensity: 0.25 }]);
  });

  it("calls the Android object when that is what is there", () => {
    const calls: Array<[string, number]> = [];
    withWindow({ StapesNative: { haptic: (k: string, i: number) => calls.push([k, i]) } });

    expect(hasHaptics()).toBe(true);
    haptic("hit", 0.5);

    expect(calls).toEqual([["hit", 0.5]]);
  });

  it("clamps the intensity to the range both shells promise to read", () => {
    const posted: Array<{ intensity: number }> = [];
    withWindow({
      webkit: {
        messageHandlers: {
          stapesHaptics: {
            postMessage: (b: unknown) => posted.push(b as { intensity: number }),
          },
        },
      },
    });

    haptic("hit", 9);
    haptic("hit", -1);

    expect(posted.map((p) => p.intensity)).toEqual([1, 0]);
  });

  /**
   * A body with no hit points is a division the call site can perform, and
   * neither shell has anything sensible to do with the result.
   */
  it("gives a full thump for an intensity that is not a number", () => {
    const posted: Array<{ intensity: number }> = [];
    withWindow({
      webkit: {
        messageHandlers: {
          stapesHaptics: {
            postMessage: (b: unknown) => posted.push(b as { intensity: number }),
          },
        },
      },
    });

    haptic("hit", Number.NaN);
    haptic("hit", Number.POSITIVE_INFINITY);

    expect(posted.map((p) => p.intensity)).toEqual([1, 1]);
  });

  /**
   * A shell can tear its bridge down — a webview being released mid-session
   * does exactly that — and the caller is a tick handler. Throwing here would
   * take the frame with it.
   */
  it("swallows a bridge that throws", () => {
    withWindow({
      StapesNative: {
        haptic: () => {
          throw new Error("the shell went away");
        },
      },
    });

    expect(() => haptic("hit", 1)).not.toThrow();
  });
});
