import { MAX_COMMAND_LENGTH } from "../../app/game/commands";
import { formatClock, type MinutesOfDay } from "../../app/lib/clock";
import { describeCall, type BotCall } from "./tools";

/**
 * What a bot knows that is not in front of it.
 *
 * `./view` is a pure function of the world: it answers "what can this body see
 * right now", and it is rebuilt from a snapshot every decision. This is the
 * other half — a function of the bot's own history, which no snapshot carries.
 * They are kept apart because they go stale for different reasons and are
 * testable against different things.
 *
 * ## The bug this exists for
 *
 * `BotBody.view` **drains** the event log, so a sentence is read exactly once.
 * That is right for the view — a notice offered twice is a bot acting on it
 * twice — and it left a bot with no evidence at all that it had ever spoken. In
 * a live run one bot asked the same person the same question three seconds
 * running, at a prompt whose digest was identical each time, because by the
 * second decision "You said: ..." had already been read and thrown away.
 *
 * So the log below keeps what the event log drops. Its whole job is to make "I
 * have already asked that" knowable.
 *
 * ## One list, in the order things happened
 *
 * Both the bot's own calls and the sentences the world sent back go in the same
 * list, interleaved, oldest first. Not two lists and not grouped by decision: a
 * decision is an artifact of how this runner is built and the world has no such
 * unit, and the question a model is trying to answer — did the person I spoke to
 * answer me — is a question about the order of a call and an event, which
 * grouping them separately hides.
 *
 * Every line carries the world's clock when it was written down. That is the
 * measurement worth having: a game minute is a real second (see
 * `MS_PER_CLOCK_MINUTE`), so at roughly a decision a second the stamps differ
 * line to line and say how long ago each thing was, which is what "have they had
 * time to reply" needs.
 *
 * ## Two writes, in the order the runner makes them
 *
 * {@link observed} takes the sentences that arrived since the last decision.
 * {@link decided} takes what the model has just asked for. Called in that order
 * they land in the order they happened, because the events being handed over are
 * older than the decision being made about them.
 *
 * Everything here is bounded, because a bot decides continuously and the prompt
 * is the running cost. See {@link REMEMBERED_ENTRIES} and the three limits under
 * it.
 */

/** One thing that happened, kept after the event log that carried it drained. */
type RememberedEntry = {
  /** The world's clock when this was written down, not when it is rendered. */
  at: MinutesOfDay;
  /** The world's own sentence, or {@link describeCall}'s. */
  line: string;
};

/**
 * How many lines are carried forward.
 *
 * Counted in lines rather than decisions, because a quiet decision produces one
 * line and a busy one produces several, and it is the lines that are the cost.
 * Twenty is between one and two minutes of ordinary play, which is long enough
 * for the repeated-question bug: a bot sees it spoke while a person is still
 * typing a reply. Anything much longer is a memory *store* with a retrieval
 * question attached, which is a different feature.
 */
export const REMEMBERED_ENTRIES = 20;

/**
 * How many sentences one drain may contribute.
 *
 * A fight, or a walk through a crowd, produces far more sentences in one second
 * than a quiet minute does, and without this a single busy drain would push
 * everything the bot said out of the window — the one thing it is here to keep.
 * The *first* ones are kept rather than the last, because those are the ones
 * that answered the last decision; the freshest are in the view already, where
 * they are read in full.
 */
const MAX_EVENTS_PER_OBSERVATION = 10;

/** Room for the "Ivory Anteater said: " that goes in front of speech. */
const SPEAKER_PREFIX_ALLOWANCE = 64;

/**
 * How long a remembered line may be.
 *
 * Speech is the longest thing that legitimately arrives, and `say` is bounded by
 * {@link MAX_COMMAND_LENGTH}, so this is that plus room for a name in front of
 * it: no ordinary sentence is ever cut. What it stops is a line long enough to
 * be a bug — nothing enforces the length of a notice, and a bot can be spoken to
 * by anybody. Truncation rather than a drop, because a line that begins "You
 * cannot reach" has said the useful part by the time it is cut.
 */
const MAX_REMEMBERED_LINE = MAX_COMMAND_LENGTH + SPEAKER_PREFIX_ALLOWANCE;

/**
 * How much of a prompt the log may take.
 *
 * The two limits above multiply: twenty clamped lines is over six thousand
 * characters, larger than the view they would be attached to. This is the
 * ceiling that actually holds, and it is enforced by dropping the oldest lines —
 * a bot decides continuously and the prompt is its running cost, so a busy
 * minute is paid for with the far end of the log.
 *
 * Three thousand is about seven hundred tokens against a view of roughly a
 * thousand. Twenty ordinary lines are around nine hundred characters, so in
 * ordinary play this never binds.
 */
const MAX_REMEMBERED_CHARS = 3_000;

const HAPPENED_HEADING = "## What has happened";

export class BotMemory {
  /** Oldest first. Never longer than {@link REMEMBERED_ENTRIES}. */
  private readonly entries: RememberedEntry[] = [];
  private goal: string | null = null;
  /**
   * The sentences the last decision already wrote down.
   *
   * `body.apply` pushes `describeCall`'s sentence into the event log, so every
   * action echoes back on the next drain as a line this log is already carrying.
   * Held between the two writes so that echo can be dropped rather than kept
   * twice.
   */
  private justDid: readonly string[] = [];

  /**
   * Write down the sentences that have just been drained.
   *
   * Called with exactly what the view was built from, and *after* the prompt is
   * built, so the same events are not shown twice in one prompt: the view
   * already renders them under its own heading, and this is where they go to
   * survive the next drain.
   */
  observed(events: readonly string[], atMinutes: MinutesOfDay) {
    const echoes = this.justDid;
    this.justDid = [];
    const fresh = events
      .map(clamp)
      .filter((line) => !echoes.includes(line))
      .slice(0, MAX_EVENTS_PER_OBSERVATION);
    this.record(fresh, atMinutes);
  }

  /** Write down what the model has just asked for, and take its goal. */
  decided(calls: readonly BotCall[], atMinutes: MinutesOfDay) {
    for (const call of calls) {
      if (call.tool === "set_goal") this.goal = clamp(call.text);
    }
    const lines = calls.map((call) => clamp(describeCall(call)));
    this.justDid = lines;
    this.record(lines, atMinutes);
  }

  /** The goal in force, or null if the model has not written one down. */
  currentGoal(): string | null {
    return this.goal;
  }

  /**
   * The memory half of a prompt, rendered the way `./view` renders the other.
   *
   * Markdown headings and plain sentences, for the same reason the view uses
   * them: the sentences are the world's own English, and a shape a model reads
   * without being taught it costs nothing to produce.
   */
  render(): string {
    const sections = [this.renderGoal()];
    if (this.entries.length > 0) sections.push(this.renderEntries());
    return sections.join("\n\n");
  }

  private renderGoal(): string {
    if (this.goal === null) {
      return "## Your goal\nYou have not set one. Call set_goal to write down what you are trying to do.";
    }
    return `## Your goal\n${this.goal}`;
  }

  /**
   * The log, oldest first, one line each behind the clock it was written at.
   *
   * Every sentence already says whose act it was — "You said", "Deer said",
   * "There is no way there" — so nothing is added to mark which of them the bot
   * did and which it merely saw.
   *
   * Built newest first and then turned round, because {@link
   * MAX_REMEMBERED_CHARS} is spent on the most recent lines and an older one
   * that will not fit is simply not rendered.
   */
  private renderEntries(): string {
    const lines: string[] = [];
    let chars = 0;
    for (let index = this.entries.length - 1; index >= 0; index--) {
      const entry = this.entries[index]!;
      const line = `${formatClock(entry.at)}  ${entry.line}`;
      // The newest line goes in whatever it costs. A heading followed by nothing
      // would be worse than one over budget, and it is the line the bot most
      // needs to see.
      if (lines.length > 0 && chars + line.length > MAX_REMEMBERED_CHARS) break;
      chars += line.length;
      lines.push(line);
    }
    return [HAPPENED_HEADING, ...lines.reverse()].join("\n");
  }

  private record(lines: readonly string[], atMinutes: MinutesOfDay) {
    for (const line of lines) this.entries.push({ at: atMinutes, line });
    const excess = this.entries.length - REMEMBERED_ENTRIES;
    if (excess > 0) this.entries.splice(0, excess);
  }
}

function clamp(line: string): string {
  if (line.length <= MAX_REMEMBERED_LINE) return line;
  return `${line.slice(0, MAX_REMEMBERED_LINE)}…`;
}
