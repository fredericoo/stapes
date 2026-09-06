import type { BotBody } from "./body";
import {
  promptDigest,
  type BotDecisionLog,
  type BotModel,
} from "./model";
import { MAX_ACTIONS_PER_DECISION } from "./tools";
import { renderBotView } from "./view";

/**
 * One bot deciding, over and over, for as long as it is allowed to.
 *
 * The loop is continuous: the next decision starts when the last one ends, so
 * reaction speed is bounded by how fast the provider answers and by nothing
 * else. What bounds the *spend* is {@link DecisionGuard}, which is separate
 * because it is arithmetic over a clock and is worth being able to test without
 * a world or a provider anywhere near it.
 *
 * The body keeps moving between decisions — see `./body` — so a slow answer
 * costs a bot its reaction time rather than freezing it mid-stride.
 */

/** How often the body's own clock advances. */
export const BOT_FRAME_MS = 50;

export type BotLimits = {
  /** The ceiling on spend, per bot. */
  maxDecisionsPerMinute: number;
  /** Consecutive provider failures before the bot is parked. */
  failureLimit: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
};

export const DEFAULT_BOT_LIMITS: BotLimits = {
  maxDecisionsPerMinute: 30,
  failureLimit: 5,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
};

const ONE_MINUTE_MS = 60_000;

/**
 * How long a bot must wait before it is allowed to think again, and whether it
 * has stopped being allowed to at all.
 *
 * Three guards, and they are three because they answer three different failures.
 * The rate ceiling bounds spend on a bot that is working perfectly. The backoff
 * bounds spend on a provider that is failing and might recover. The breaker
 * stops a bot that is failing and clearly will not — it parks, standing still,
 * costing nothing, until somebody looks at the log.
 *
 * A repeat-death loop is none of these and the breaker will not catch it: dying
 * is not an *error*, and the bot is expected to have the death in its events and
 * to avoid what killed it. If that turns out not to work, a rebirth cooldown is
 * the fix, and it is a different guard.
 */
export class DecisionGuard {
  /** When each decision in the last minute started, oldest first. */
  private readonly started: number[] = [];
  private consecutiveFailures = 0;
  /** When the backoff imposed by the last failure runs out. */
  private retryAtMs = 0;

  constructor(private readonly limits: BotLimits) {}

  /** Has this bot given up? Parked bots stand still and spend nothing. */
  get parked(): boolean {
    return this.consecutiveFailures >= this.limits.failureLimit;
  }

  /** Milliseconds until a decision may start. Zero means now. */
  waitMs(nowMs: number): number {
    if (this.parked) return Number.POSITIVE_INFINITY;
    const backoff = Math.max(0, this.retryAtMs - nowMs);
    this.forgetOlderThan(nowMs - ONE_MINUTE_MS);
    if (this.started.length < this.limits.maxDecisionsPerMinute) return backoff;
    // The oldest decision in the window is what has to fall out of it, so the
    // wait is exactly how long that takes and never a fixed sleep.
    const oldest = this.started[0]!;
    return Math.max(backoff, oldest + ONE_MINUTE_MS - nowMs);
  }

  noteStart(nowMs: number) {
    this.started.push(nowMs);
  }

  noteSuccess() {
    this.consecutiveFailures = 0;
    this.retryAtMs = 0;
  }

  /**
   * Note a provider failure and say when to try again.
   *
   * Exponential from the first failure rather than after a few free ones: the
   * cheap failures — a rate limit, a five-hundred — are exactly the ones that
   * come back immediately if you ask again immediately, and a bot that retried
   * a working provider at full speed is the same bot that hammers a broken one.
   */
  noteFailure(nowMs: number) {
    this.consecutiveFailures += 1;
    const delay = Math.min(
      this.limits.backoffMaxMs,
      this.limits.backoffBaseMs * 2 ** (this.consecutiveFailures - 1),
    );
    this.retryAtMs = nowMs + delay;
  }

  private forgetOlderThan(cutoffMs: number) {
    while (this.started.length > 0 && this.started[0]! <= cutoffMs) {
      this.started.shift();
    }
  }
}

export type BotRunnerOptions = {
  body: BotBody;
  model: BotModel;
  limits?: BotLimits;
  /** Injected so the guards can be driven without waiting for a real minute. */
  now?: () => number;
  log?: (line: BotDecisionLog) => void;
};

export class BotRunner {
  private readonly body: BotBody;
  private readonly model: BotModel;
  private readonly guard: DecisionGuard;
  private readonly now: () => number;
  private readonly log: (line: BotDecisionLog) => void;
  private stopped = false;

  constructor(options: BotRunnerOptions) {
    this.body = options.body;
    this.model = options.model;
    this.guard = new DecisionGuard(options.limits ?? DEFAULT_BOT_LIMITS);
    this.now = options.now ?? Date.now;
    this.log = options.log ?? logDecision;
  }

  get parked(): boolean {
    return this.guard.parked;
  }

  /** Advance the body's own clock. Driven by {@link run}, or by a test. */
  tick(dtMs: number) {
    this.body.tick(dtMs);
  }

  /**
   * One round trip: build the view, ask, apply what came back.
   *
   * Everything is applied in the order the model asked for it, and at most
   * {@link MAX_ACTIONS_PER_DECISION} of them — a model that returned twenty
   * calls has misunderstood, and honouring them would be twenty decisions'
   * worth of movement bought with one.
   *
   * Returns whether a decision was actually taken, which is what {@link run}
   * needs in order to know it should wait rather than spin.
   */
  async decideOnce(): Promise<boolean> {
    // Not merely joined but settled — see `./body`'s `isSettled`. A bot that
    // acts on the frame its `hello` lands walks one cell further than it meant
    // to, every time.
    if (!this.body.isSettled()) return false;
    // The only thing a dead session may say, and it costs nothing to say. Asking
    // a model what to do with no body would be spending on a turn whose only
    // legal move is this one.
    if (this.body.isDead()) {
      this.body.rebirth();
      return false;
    }
    if (this.guard.waitMs(this.now()) > 0) return false;

    const prompt = renderBotView(this.body.view());
    const startedMs = this.now();
    this.guard.noteStart(startedMs);

    try {
      const decision = await this.model.decide({ prompt });
      const actions = decision.actions.slice(0, MAX_ACTIONS_PER_DECISION);
      for (const action of actions) this.body.apply(action);
      this.guard.noteSuccess();
      this.log({
        bot: this.body.name(),
        promptDigest: promptDigest(prompt),
        promptChars: prompt.length,
        actions,
        latencyMs: this.now() - startedMs,
        inputTokens: decision.usage.inputTokens,
        outputTokens: decision.usage.outputTokens,
      });
      return true;
    } catch (error) {
      this.guard.noteFailure(this.now());
      this.log({
        bot: this.body.name(),
        promptDigest: promptDigest(prompt),
        promptChars: prompt.length,
        actions: [],
        latencyMs: this.now() - startedMs,
        inputTokens: null,
        outputTokens: null,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  stop() {
    this.stopped = true;
  }

  /**
   * The two clocks, wired to real timers.
   *
   * Deliberately thin, and everything it does is a method the suite drives
   * directly: the frame clock is {@link tick} on an interval, and the decision
   * loop is {@link decideOnce} awaited in a loop with the guard's own answer for
   * how long to wait. There is nothing here to test that testing the two parts
   * does not already cover, which is why it is shaped this way.
   */
  async run(): Promise<void> {
    const frames = setInterval(() => this.tick(BOT_FRAME_MS), BOT_FRAME_MS);
    try {
      while (!this.stopped) {
        if (this.guard.parked) return;
        const decided = await this.decideOnce();
        if (decided) continue;
        // Finite, because the one answer that is not is being parked, and that
        // is what the check above just returned on. A frame at minimum, so a bot
        // that is dead or still settling waits rather than spinning.
        await sleep(Math.max(BOT_FRAME_MS, this.guard.waitMs(this.now())));
      }
    } finally {
      clearInterval(frames);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One line per decision, as JSON.
 *
 * Structured rather than prose because what anybody wants from it is a query —
 * what did this bot do, how long did it take, what did it cost — and the answers
 * are a `jq` away only if the fields are fields. The prompt itself is never
 * logged: it is a page of text per decision, several times a minute, per bot, and
 * the digest beside it answers the question the text would have.
 */
function logDecision(line: BotDecisionLog) {
  console.log(`[bot] ${JSON.stringify(line)}`);
}
