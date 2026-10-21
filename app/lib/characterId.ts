/**
 * Commands read a word that is not a number as an actor id, so a character's
 * id starts with a letter and never reads as one. `p` also keeps it apart from
 * a resident's, which starts with `n`.
 */
const CHARACTER_ID_PREFIX = "p";
const CHARACTER_ID_RADIX = 36;

/**
 * A character's id is its place in the order characters were made, in base 36,
 * because it is repeated in every cell and event about the body on the wire.
 */
export function characterIdOf(serial: number): string {
  return `${CHARACTER_ID_PREFIX}${serial.toString(CHARACTER_ID_RADIX)}`;
}
