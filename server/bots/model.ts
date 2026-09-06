import { MAX_CALLS_PER_DECISION } from "./tools";
import type { BotCall } from "./tools";

/**
 * The one thing a provider has to do, and the whole of what the runner knows
 * about one.
 *
 * A seam rather than a call into an SDK, and it is load-bearing twice over. It
 * is what makes the suite deterministic and free — a stub returning scripted
 * actions is a four-line class — and it is what makes the provider a small,
 * obvious edit rather than a rewrite, which matters because nobody has yet
 * chosen between Gemini Flash and Grok. `./tanstackModel` is the real one and is
 * imported only by `./main`, so nothing under test ever loads the SDK.
 */
export interface BotModel {
  /** One round trip. Up to {@link MAX_CALLS_PER_DECISION} calls come back. */
  decide(request: BotDecisionRequest): Promise<BotDecision>;
}

export type BotDecisionRequest = {
  /** The bot's memory and then its view. See `./memory` and `./view`. */
  prompt: string;
  /** Dropped when the provider takes too long, or when a bot is being stopped. */
  signal?: AbortSignal;
};

export type BotDecision = {
  /** In the order the model asked for them, already parsed. */
  calls: BotCall[];
  /** Whatever the model said alongside the calls, for the log. */
  text: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
};

/** One decision, as it goes into the log. */
export type BotDecisionLog = {
  bot: string;
  /** An identity for the prompt, so two identical views are visibly identical. */
  promptDigest: string;
  promptChars: number;
  /**
   * What the model asked for. A `set_goal` among them is how the goal a bot is
   * carrying stays readable in the log, since the prompt itself never is.
   */
  calls: BotCall[];
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Present only when the provider failed. */
  error?: string;
};

/**
 * A short, stable identity for a prompt.
 *
 * FNV-1a, and deliberately not a cryptographic digest: what a log line needs is
 * to be able to say "this is the same view it saw last time", which is a
 * comparison between two of our own lines rather than a claim anybody else has
 * to trust. It is also synchronous, where `crypto.subtle` is not, and a hash on
 * the decision path should not be a promise.
 */
export function promptDigest(prompt: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < prompt.length; i++) {
    hash ^= prompt.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * What a bot is told it is, once, ahead of every view.
 *
 * Short on purpose. The rules of this world are not written down here and are
 * not meant to be: the server already renders every refusal and outcome as
 * English, and those sentences arrive in the next decision's events. A model
 * that learns "you cannot reach that from here" by being refused has learnt the
 * rule that is actually in force, where a paragraph in a system prompt is a rule
 * somebody wrote down once and may since have changed.
 */
export const BOT_SYSTEM_PROMPT = `You are playing a character in a small tile world. You are not an assistant; you are a person in this place, and you decide what your body does next.

Each turn you are shown your goal, then what has happened recently, and then what you can see: a grid of the world around you with your coordinates written down every edge, a legend saying what each character is, the bodies in sight, what you could do from where you stand, and everything that happened since your last turn.

Your goal is a sentence you wrote yourself with set_goal and it stands until you replace it, so write one down as soon as you decide on something. What has happened is the last twenty things you did and saw, oldest first, each behind the time of day it happened at, and together with the goal it is the whole of what you carry forward — everything else you are shown is only true this instant. Read it before you act: it is how you know what you have already said, already tried and already been refused. The clock runs a minute for every second of your time, so a line a minute old is one turn ago.

The grid is what you can see and nothing more. '?' is a cell you have no line to — behind a wall, under a roof, round a corner — and you must not assume what is in one. '.' is a cell with nothing in it at all: open air, and possibly a drop with a floor somewhere below that you cannot see.

Call between one and ${MAX_CALLS_PER_DECISION} tools, in the order you want them done — set_goal counts as one of them. You will not be told the result inline; it reaches you in the next turn's events, refusals included. Read those — they are the rules of this world in the words a player reads.

Speak rarely. Say something only when there is another person in sight to say it to, and only when you have something new to say. Never ask a question twice — not in other words, not more politely, not "once more". If you have asked and nobody has answered, they are thinking, or busy, or gone: leave it for many turns and get on with something else. Read what you have already said before you speak, and if the thing you are about to say is already there, do not say it. A person who repeats himself every few seconds is not talked to for long.

Use walk_to when you know where you are going. Use step when you do not: it is the only way into a cell whose floor you cannot see, and falling is how you find out what is below you.

Keep moving and keep looking. Somewhere you have not been is worth more than standing still.`;
