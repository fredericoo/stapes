/**
 * Link previews on Reddit, Instagram and the rest are fetched by crawlers that
 * need an absolute image URL, and the public pages are prerendered, so the
 * origin is written down rather than read. @see docs/deploy.md
 */
export const CANONICAL_ORIGIN = "https://thelaststones.com";

/**
 * Every file in `./media`, by name, as the URL the build gives it. The build
 * names a file after a hash of its contents, and the server caches anything
 * that is not a page for a year, so a clip recorded again under the same name
 * reaches everybody at a new URL instead of staying stale in their cache.
 */
const MEDIA = import.meta.glob<string>("./media/**/*", {
  eager: true,
  query: "?url",
  import: "default",
});

export function media(name: string): string {
  const url = MEDIA[`./media/${name}`];
  if (!url) throw new Error(`There is no ${name} in app/components/home/media`);
  return url;
}

type FeatureMedia = { kind: "video"; src: string; poster: string } | { kind: "devices" };

export type Feature = {
  id: string;
  title: string;
  body: string;
  /** What the footage shows, in a sentence. */
  caption: string;
  stone: string;
  media: FeatureMedia;
};

function clip(name: string): FeatureMedia {
  return { kind: "video", src: media(`${name}.mp4`), poster: media(`${name}.webp`) };
}

export function sprite(name: string): string {
  return media(`sprites/${name}.png`);
}

export const FEATURES: Feature[] = [
  {
    id: "masteries",
    title: "No levels. No classes.",
    body: "You get better at what you do. Swing a sword and your sword skill goes up. Cast fire and your fire gets stronger. Your character is whatever you spent your time on.",
    caption: "Osric fights a wolf at midday. Sharp goes from 3 to 6.",
    stone: sprite("stone-blank"),
    media: clip("feature-masteries"),
  },
  {
    id: "animals",
    title: "Animals live their own lives",
    body: "Wolves hunt deer. Some creatures only come out at night. They listen as well as look, so making noise can bring something to you.",
    caption: "Just before dawn, a wolf runs down a deer and eats it.",
    stone: sprite("stone-thorns"),
    media: clip("feature-animals"),
  },
  {
    id: "ruins",
    title: "Some ruins need friends",
    body: "Under the ground are the ruins of an old city. Some floors only open when enough people stand on the plates at once, and some guardians are too strong for one person.",
    caption: "Osric stands on the plate to open the door. Wren goes in to the cyclops.",
    stone: sprite("stone-frost"),
    media: clip("feature-ruins"),
  },
  {
    id: "fire",
    title: "The world changes",
    body: "Trees burn down. Rivers freeze, and you can walk across them. What you change above ground stays changed.",
    caption: "Two players cast Flame at a line of trees as night falls.",
    stone: sprite("stone-flame"),
    media: clip("feature-fire"),
  },
  {
    id: "devices",
    title: "Phone or computer",
    body: "It runs in the browser. Same world, same people, whichever you pick up. Start on a laptop and carry on from your phone.",
    caption: "Wren outside the Gilded Barrel, on a phone and on a laptop.",
    stone: sprite("stone-spark"),
    media: { kind: "devices" },
  },
];

export type Danger = {
  id: string;
  title: string;
  body: string;
  sprite: string;
  /** The sprite's size in the game's 8px cells, so each one is scaled by the same amount. */
  widthCells: number;
  heightCells: number;
};

export const DANGERS: Danger[] = [
  {
    id: "fire",
    title: "Fire burns",
    body: "Walk into a flame and you catch fire. A new character can burn to death in a few seconds.",
    sprite: sprite("danger-flame"),
    widthCells: 2,
    heightCells: 2,
  },
  {
    id: "food",
    title: "Food goes bad",
    body: "Raw meat will probably poison you, and berries and cheese go off within the hour. Food poisoning can kill. Cook your meat and eat things fresh.",
    sprite: sprite("danger-raw-meat"),
    widthCells: 1,
    heightCells: 1,
  },
  {
    id: "rats",
    title: "Rats come in numbers",
    body: "One rat is easy. But rats go for anyone they see, and where there is one there are usually more. Enough of them at once will kill you.",
    sprite: sprite("danger-rat"),
    widthCells: 2,
    heightCells: 1,
  },
];

export type ShotSpan = "big" | "wide" | "one";

export type Shot = {
  id: string;
  src: string;
  /** The same picture at half the width, for the grid; without one the grid shows `src`. */
  half?: string;
  width: number;
  height: number;
  alt: string;
  caption: string;
  span: ShotSpan;
  /** A shot with a video plays it in the lightbox, and shows `src` until it loads. */
  video?: string;
  /** Pixel art is scaled without smoothing; a screenshot of the interface is not. */
  pixelated: boolean;
};

/** The footage and most stills: the 184px view at six screen pixels to one of its own. */
const SQUARE_PX = 1104;
const SCREENSHOT_WIDTH_PX = 2560;
const SCREENSHOT_HEIGHT_PX = 1568;

type ShotFields = Omit<Shot, "id" | "src" | "width" | "height"> &
  Partial<Pick<Shot, "width" | "height">>;

/** A square still with a half-size copy, unless `fields` says otherwise. */
function shot(name: string, fields: ShotFields): Shot {
  return {
    id: name,
    src: media(`${name}.webp`),
    half: media(`${name}-half.webp`),
    width: SQUARE_PX,
    height: SQUARE_PX,
    ...fields,
  };
}

export const SHOTS: Shot[] = [
  shot("shot-inn", {
    alt: "The Gilded Barrel from above at midday, its roof lifted off: tables, drinkers, and the bartender behind the counter.",
    caption: "Inside the Gilded Barrel at midday.",
    span: "big",
    pixelated: true,
  }),
  shot("shot-cast", {
    alt: "Wren casting Pyre at a wolf in a ruined field. A bar fills above Wren and a dotted line runs to the wolf.",
    caption: "Casting Pyre at a wolf. The bar fills, then the bolt flies.",
    span: "one",
    pixelated: true,
  }),
  shot("shot-cyclops", {
    alt: "Inside a ruined stone tower, a cyclops bellows at Wren while Osric waits on a pressure plate outside.",
    caption: "The cyclops in the old tower, and the plate outside its door.",
    span: "one",
    pixelated: true,
  }),
  shot("shot-smithy", {
    alt: "The game on a computer: Wren at the blacksmith, whose panel lists an iron sword for 20, a knight's sword for 50 and a tempered longsword for 95.",
    caption: "The blacksmith's rack.",
    span: "wide",
    pixelated: false,
    width: SCREENSHOT_WIDTH_PX,
    height: SCREENSHOT_HEIGHT_PX,
  }),
  shot("shot-lake", {
    alt: "Wren holding a torch beside an underground lake, with a blue arcane crystal glowing nearby. Everything past the torchlight is dark.",
    caption: "A torch at the edge of an underground lake.",
    span: "one",
    pixelated: true,
  }),
  shot("shot-lair", {
    alt: "A cave troll beside its fire, three floors underground, with a chest in the dark stone room behind it.",
    caption: "A cave troll by its fire, three floors down.",
    span: "one",
    pixelated: true,
  }),
  shot("shot-dusk", {
    alt: "Dusk over a field of ruined walls ringed by forest. A fire burns in the corner of one ruin and a wolf is out.",
    caption: "Dusk over the ruined field.",
    span: "one",
    pixelated: true,
  }),
  {
    id: "nightfall",
    src: media("nightfall.webp"),
    video: media("nightfall.mp4"),
    width: SQUARE_PX,
    height: SQUARE_PX,
    alt: "The main street through town as the afternoon turns to night, sped up. Lamps light the road as it gets dark.",
    caption: "An evening in town, ten times faster.",
    span: "one",
    pixelated: true,
  },
];

export const DISCORD_INVITE = "https://discord.gg/QbZ6rtG92";
