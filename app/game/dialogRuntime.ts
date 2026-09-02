import { hearsAny, type DialogDef, type DialogTopic } from "../lib/dialog";
import type { BattlerDef } from "../lib/battler";
import type { Coord } from "../lib/types";
import { NOBODY, within, type Utterance } from "./brainRuntime";

/**
 * One NPC holding one conversation, a tick at a time.
 *
 * The sibling of `stepBrain` and shaped like it on purpose: a pure step over
 * (def, memory, what was heard) that mutates the memory and hands back what to
 * say, so a test can drive a whole conversation without a session and the
 * editor can run the same function against a typed line. Nothing here knows
 * how a word reached the ear or how a line reaches a bubble.
 *
 * ## Who is heard
 *
 * The same `pendingHeard` page the brain reads, seen on exactly one tick and
 * then gone — see `GameSession.hear`. Every utterance is first checked for
 * earshot on the dialog's own `cells` and `los`, so somebody shouting "hi"
 * from across the map is not a partner and does not even earn a busy line.
 *
 * ## What ends it
 *
 * `bye`, said by the partner, with its line. Silence for `idleMs`, or the
 * partner leaving earshot, with none: the NPC simply stops waiting, and the
 * next greeting from anybody starts fresh. Both are checked before this tick's
 * words are read, so a partner who walked off and shouted from too far away
 * is a stranger by the time the word arrives.
 */

export type DialogMemory = {
  /** Whoever this body is talking to, or null between conversations. */
  partnerId: string | null;
  /**
   * Indices from the root topics to the reply whose `then` is live, or empty
   * when only the root topics are. A path rather than a topic reference so a
   * def reloaded under the memory still resolves to *a* topic or to nothing.
   */
  path: number[];
  /** Milliseconds since the partner last said anything. */
  msSilent: number;
};

/**
 * The narrow view of the world a conversation needs — `BrainContext` with the
 * legs cut off. The same members, on the same terms, so the session builds
 * both from one place.
 */
export type DialogView = {
  self: Coord;
  sight: BattlerDef["sight"];
  positionOf(actorId: string): Coord | null;
  canSee(at: Coord): boolean;
  nameOf(actorId: string): string | null;
  heard(): readonly Utterance[];
};

export function initialDialogMemory(): DialogMemory {
  return { partnerId: null, path: [], msSilent: 0 };
}

/** Is this body mid-conversation? What the brain's `talking` condition reads. */
export function isTalking(memory: DialogMemory | null): boolean {
  return memory?.partnerId != null;
}

/**
 * Advance a conversation by one tick, answering what was heard.
 *
 * Returns the lines to say, in order, with `{partner}` filled in. The memory is
 * mutated in place, exactly as `stepBrain` mutates its own.
 */
export function converse(
  dialog: DialogDef,
  memory: DialogMemory,
  tickMs: number,
  view: DialogView,
): string[] {
  const says: string[] = [];
  const say = (line: string) => says.push(fillPartner(line, memory, view));

  memory.msSilent += tickMs;
  if (memory.partnerId !== null && !stillEngaged(dialog, memory, view)) {
    endConversation(memory);
  }

  // Once per pass, however many strangers spoke: a busy line per word would be
  // a shopkeeper shouting over a crowd.
  let busySaid = false;

  for (const utterance of view.heard()) {
    if (!inEarshot(dialog, utterance.speakerId, view)) continue;

    if (memory.partnerId === null) {
      if (!hearsAny(utterance.text, dialog.greet.hear)) continue;
      memory.partnerId = utterance.speakerId;
      memory.path = [];
      memory.msSilent = 0;
      say(dialog.greet.say);
      continue;
    }

    if (utterance.speakerId !== memory.partnerId) {
      if (busySaid || !dialog.busy) continue;
      if (!hearsAny(utterance.text, dialog.greet.hear)) continue;
      busySaid = true;
      say(dialog.busy);
      continue;
    }

    memory.msSilent = 0;
    if (hearsAny(utterance.text, dialog.bye.hear)) {
      say(dialog.bye.say);
      endConversation(memory);
      continue;
    }

    const found = liveTopics(dialog, memory.path).find(({ topic }) =>
      hearsAny(utterance.text, topic.hear),
    );
    if (!found) continue;
    memory.path = found.topic.then?.length ? found.path : [];
    say(found.topic.say);
  }

  return says;
}

/**
 * The topics an utterance may match right now, in the order they are tried.
 *
 * The live reply's `then` first, then the root — so "yes" answers the question
 * just asked before it answers anything else, and a root topic is always
 * reachable however deep the conversation has gone.
 */
function liveTopics(
  dialog: DialogDef,
  path: readonly number[],
): Array<{ topic: DialogTopic; path: number[] }> {
  const root = dialog.topics.map((topic, index) => ({ topic, path: [index] }));
  const current = topicAt(dialog, path);
  if (!current?.then?.length) return root;
  const children = current.then.map((topic, index) => ({
    topic,
    path: [...path, index],
  }));
  return [...children, ...root];
}

/** The topic a path names, or null when the def no longer has one there. */
function topicAt(
  dialog: DialogDef,
  path: readonly number[],
): DialogTopic | null {
  let topics: readonly DialogTopic[] = dialog.topics;
  let found: DialogTopic | null = null;
  for (const index of path) {
    found = topics[index] ?? null;
    if (!found) return null;
    topics = found.then ?? [];
  }
  return found;
}

function stillEngaged(
  dialog: DialogDef,
  memory: DialogMemory,
  view: DialogView,
): boolean {
  if (memory.msSilent >= dialog.idleMs) return false;
  return inEarshot(dialog, memory.partnerId!, view);
}

function endConversation(memory: DialogMemory) {
  memory.partnerId = null;
  memory.path = [];
  memory.msSilent = 0;
}

/**
 * Is this body near enough — and, if the dialog asks, in view — to be talked
 * to? Measured on the brain's own terms, sight levels included.
 */
function inEarshot(
  dialog: DialogDef,
  actorId: string,
  view: DialogView,
): boolean {
  const at = view.positionOf(actorId);
  if (at === null) return false;
  if (!within(view.self, at, dialog.cells, view.sight)) return false;
  return !dialog.los || view.canSee(at);
}

const PARTNER_PLACEHOLDER = /\{partner\}/g;

/**
 * An authored line with `{partner}` filled in.
 *
 * One placeholder rather than the brain's slot syntax, because a conversation
 * has exactly one person in it worth naming. The fallback is the brain's own
 * word for a subject that has gone missing, so a partner who logged out
 * mid-sentence reads the same way here as there.
 */
function fillPartner(
  line: string,
  memory: DialogMemory,
  view: DialogView,
): string {
  if (!line.includes("{")) return line;
  const id = memory.partnerId;
  const name = (id === null ? null : view.nameOf(id)) ?? NOBODY;
  return line.replace(PARTNER_PLACEHOLDER, name);
}
