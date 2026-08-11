/**
 * What to call somebody.
 *
 * Identity online is a random uuid in a cookie, and a uuid is not a name: six
 * characters of it drawn over a head ("3F9AC1") are legible, unique and
 * completely unrecognisable, so a room full of people reads as a room full of
 * serial numbers. What a name has to do here is let you pick your friend out of
 * a crowd a second after they walk in, which means it has to be *sayable* —
 * hence a colour and an animal, "Green Fox", out of common-word lists.
 *
 * Derived, not stored: the same actor gets the same name on every client and
 * across reconnects, without a name ever going on the wire. When people can
 * choose their own this is the one function they replace, and until then the id
 * is still the identity — the name is only how it is spoken aloud.
 *
 * Two people can be handed the same name. There are 52 × 355 ≈ 18k pairs, so it
 * takes a couple of dozen actors in one world before it is even worth thinking
 * about, and nothing downstream depends on a name being unique: labels,
 * ownership and speech are all keyed by id.
 */

// Two word lists out of the eight in the package, and only two arrive in the
// bundle: they are plain exported consts in a module marked side-effect free,
// so the star wars characters and the 1200 adjectives shake out. Verified in a
// production build — worth re-checking if a third list is ever added here.
import { animals, colors } from "unique-names-generator";

/**
 * Our own hash rather than the generator's `seed`, which is not a hash.
 *
 * `uniqueNamesGenerator({ seed })` turns a string seed into a number by summing
 * its char codes. A uuid is 36 characters drawn from 16 hex digits and a dash,
 * so that sum lands in a band of a couple of thousand values — most of the 18k
 * names would be unreachable, and collisions would be an order of magnitude
 * more likely than the dictionaries suggest. FNV-1a over the same string uses
 * every character in its position and spreads across the whole range.
 */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function hash(text: string): number {
  let accumulated = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i++) {
    accumulated ^= text.charCodeAt(i);
    // `imul` and not `*`: the product overflows a double's exact integer range,
    // and rounding it would throw away the low bits the next round mixes.
    accumulated = Math.imul(accumulated, FNV_PRIME);
  }
  return accumulated >>> 0;
}

/**
 * The two halves come from separately salted hashes of the same id, so each is
 * a full-strength draw. Carving both out of one 32-bit hash would have them
 * share bits, and how badly depends entirely on how it is carved — a shift
 * small enough to overlap the first index leaves the animal partly determined
 * by the colour. Salting sidesteps the question rather than getting it right.
 */
function pick(words: readonly string[], id: string, salt: string): string {
  return words[hash(`${salt}:${id}`) % words.length];
}

/**
 * Capitalised, because it is a name.
 *
 * The handle this replaced was uppercase so that a tag would not read as a
 * sentence, and that argument still holds where it matters — the name hangs
 * over a head in the same face as the words people say. Two capitals in a
 * two-word name carry it, and "Green Fox" is a thing you would call someone
 * out loud in a way "GREEN FOX" is not.
 */
function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function displayNameFor(actorId: string): string {
  const colour = pick(colors, actorId, "colour");
  const animal = pick(animals, actorId, "animal");
  return `${capitalise(colour)} ${capitalise(animal)}`;
}
