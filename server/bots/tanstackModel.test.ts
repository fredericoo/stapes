import { describe, expect, it } from "bun:test";
import { toJsonSchema } from "@valibot/to-json-schema";
import { BOT_TOOLS } from "./tools";
import { readBotConfig } from "./config";
import { botAdapter } from "./tanstackModel";

/**
 * Turning configuration into a provider.
 *
 * The one part of `./tanstackModel` a test can reach without a key and without
 * spending anything: building an adapter talks to nobody. What it pins is the
 * check that costs the most to get wrong — a model name out of the environment
 * that the provider will not answer to starts a process, joins the world, and
 * fails on every decision until somebody reads the log.
 *
 * The key is a placeholder because none of these cases sends a request. Every
 * provider is exercised, so adding a fourth and forgetting the case falls out
 * here rather than in production.
 */

const KEY = "not-a-real-key";

function adapterFor(env: Record<string, string>) {
  return botAdapter(readBotConfig({ BOT_API_KEY: KEY, BOT_COUNT: "1", ...env }));
}

describe("choosing a provider", () => {
  it("builds one for each provider it accepts", () => {
    expect(adapterFor({ BOT_PROVIDER: "gemini" })).toBeDefined();
    expect(adapterFor({ BOT_PROVIDER: "grok" })).toBeDefined();
    expect(adapterFor({ BOT_PROVIDER: "openai" })).toBeDefined();
  });

  it("takes a named model the provider knows", () => {
    expect(
      adapterFor({ BOT_PROVIDER: "openai", BOT_MODEL: "gpt-4o-mini" }),
    ).toBeDefined();
  });

  it("refuses a model that provider has never heard of", () => {
    expect(() =>
      adapterFor({ BOT_PROVIDER: "openai", BOT_MODEL: "gpt-4o-mimi" }),
    ).toThrow(/not an OpenAI chat model/);
  });

  it("refuses a real model asked of the wrong provider", () => {
    // The mistake this actually catches: switching provider and leaving the
    // model behind, which is one edited line in an `.env`.
    expect(() =>
      adapterFor({ BOT_PROVIDER: "gemini", BOT_MODEL: "gpt-4o-mini" }),
    ).toThrow(/not a Gemini/);
  });

  it("has nothing to build without a key", () => {
    expect(() => botAdapter(readBotConfig({ BOT_COUNT: "1" }))).toThrow(
      /BOT_API_KEY/,
    );
  });
});

/**
 * The tools, as a provider has to be shown them.
 *
 * Standard Schema says how to *validate*; carrying a JSON Schema conversion is
 * optional and valibot does not. The engine discovers that at the moment of the
 * first request — a thread open, every tool described, and then a throw — so it
 * cost a live run to find. Nothing in the suite had loaded the definitions,
 * which is why this exists: the conversion is the boundary, and it is checked
 * here rather than by a provider.
 */
describe("describing the tools to a provider", () => {
  it("converts every schema to an object schema with its arguments named", () => {
    for (const tool of BOT_TOOLS) {
      const json = toJsonSchema(tool.schema) as {
        type?: string;
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(json.type).toBe("object");
      expect(Object.keys(json.properties ?? {}).length).toBeGreaterThan(0);
      expect(json.required?.length).toBeGreaterThan(0);
    }
  });

  it("keeps the arguments each tool is actually parsed for", () => {
    const named = (name: string) => {
      const tool = BOT_TOOLS.find((candidate) => candidate.name === name)!;
      const json = toJsonSchema(tool.schema) as { properties?: object };
      return Object.keys(json.properties ?? {}).sort();
    };
    expect(named("walk_to")).toEqual(["x", "y"]);
    expect(named("step")).toEqual(["direction"]);
    expect(named("say")).toEqual(["text"]);
    expect(named("set_goal")).toEqual(["text"]);
  });
});
