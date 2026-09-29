const GIVEN_OPENINGS = [
  "Al",
  "Ash",
  "Bel",
  "Bran",
  "Brin",
  "Cae",
  "Cal",
  "Cor",
  "Dar",
  "Del",
  "Ed",
  "El",
  "Ev",
  "Fen",
  "Gar",
  "Gwen",
  "Hal",
  "Il",
  "Is",
  "Jor",
  "Kas",
  "Kel",
  "Lor",
  "Lyr",
  "Mae",
  "Mir",
  "Mor",
  "Nim",
  "Or",
  "Per",
  "Quen",
  "Ros",
  "Sael",
  "Ser",
  "Tam",
  "Tor",
  "Ul",
  "Vae",
  "Wen",
  "Yor",
];

const GIVEN_ENDINGS = [
  "a",
  "an",
  "ar",
  "as",
  "el",
  "en",
  "eth",
  "ia",
  "ian",
  "ic",
  "in",
  "is",
  "ith",
  "o",
  "on",
  "or",
  "ra",
  "ren",
  "ric",
  "wyn",
  "ys",
];

const FAMILY_OPENINGS = [
  "Ald",
  "Bram",
  "Cald",
  "Dray",
  "Esk",
  "Fal",
  "Gil",
  "Hask",
  "Ing",
  "Kest",
  "Lan",
  "Marl",
  "Nor",
  "Orm",
  "Pell",
  "Quill",
  "Rav",
  "Sten",
  "Tarn",
  "Ulm",
  "Var",
  "Wyn",
];

const FAMILY_ENDINGS = [
  "by",
  "dale",
  "ford",
  "gard",
  "holm",
  "ley",
  "mere",
  "more",
  "stead",
  "ton",
  "vale",
  "well",
  "wick",
];

function pick(words: readonly string[]): string {
  return words[Math.floor(Math.random() * words.length)]!;
}

/** Joins that repeat a letter across the seam, like `Orm` + `more`, read as typos. */
function join(openings: readonly string[], endings: readonly string[]): string {
  for (;;) {
    const opening = pick(openings);
    const ending = pick(endings);
    if (opening.at(-1)!.toLowerCase() !== ending[0]) return opening + ending;
  }
}

export function randomCharacterName(): string {
  return `${join(GIVEN_OPENINGS, GIVEN_ENDINGS)} ${join(FAMILY_OPENINGS, FAMILY_ENDINGS)}`;
}
