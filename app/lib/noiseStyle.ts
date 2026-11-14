import * as v from "valibot";

export const NOISE_STYLES = ["pop", "loud", "wavy", "shake", "whisper"] as const;

export type NoiseStyle = (typeof NOISE_STYLES)[number];

export const noiseStyleSchema = v.picklist(NOISE_STYLES);

export const NOISE_STYLE_LABELS: Record<NoiseStyle, string> = {
  pop: "Pop",
  loud: "Loud",
  wavy: "Wavy",
  shake: "Shake",
  whisper: "Whisper",
};

const MIN_SHOUTED_LETTERS = 2;

/** Three of one letter in a row is a drawn-out sound — a hiss, a breath, a snore. */
const DRAWN_OUT = /(\p{L})\1\1/iu;

/**
 * The style a noise takes when its author picked none, read from how it is
 * written: the content already spells a roar `*ROAR*` and a hiss `*sssk*`.
 */
export function inferNoiseStyle(text: string): NoiseStyle {
  const letters = text.replace(/[^\p{L}]/gu, "");
  const shouted = letters.length >= MIN_SHOUTED_LETTERS && letters === letters.toUpperCase();
  if (shouted && letters !== letters.toLowerCase()) return "loud";
  if (DRAWN_OUT.test(letters)) return "wavy";
  return "pop";
}

export function noiseStyleOf(noise: { text: string; style?: NoiseStyle }): NoiseStyle {
  return noise.style ?? inferNoiseStyle(noise.text);
}
