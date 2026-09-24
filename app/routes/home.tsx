import { type ReactNode, useEffect, useRef } from "react";
import { Link } from "react-router";
import { DoorLogo, SYSTEM_MONO } from "../components/door";
import type { Route } from "./+types/home";

/**
 * The landing page: what the game is, in a minute of reading.
 *
 * Prerendered at build time (see `react-router.config.ts`), so it has no loader
 * and reads nothing from the server — everything it says is in this file.
 *
 * The screenshots below the hero are placeholders until the captures exist.
 * Each one says what it should show, so replacing it is dropping a file in `public/home/` and
 * swapping the `<Shot>` for an `<img>`.
 *
 * Body text is set in the machine's own monospace for the reason `door.tsx`
 * gives; headings use NF Pixels, the world's own face, at 20px and 40px because
 * its pixels only land on whole CSS pixels at multiples of 10 (see `app.css`).
 * The font is preloaded because its `font-display` is `block`, and a heading
 * that stays invisible until a late download is a heading nobody reads.
 */

export function meta(): Route.MetaDescriptors {
  return [
    { title: "The Last Stones" },
    {
      name: "description",
      content:
        "A small MMO that runs in your browser, on phone or computer. No levels, no classes: you get better at what you do.",
    },
  ];
}

export const links: Route.LinksFunction = () => [
  {
    rel: "preload",
    href: "/fonts/nf-pixels-ascii.woff2",
    as: "font",
    type: "font/woff2",
    crossOrigin: "anonymous",
  },
];

const PIXEL = '"NF Pixels", monospace';

const FEATURES: { title: string; body: string; shot: string }[] = [
  {
    title: "No levels. No classes.",
    body: "You get better at what you do. Swing a sword and your sword skill goes up. Cast fire and your fire gets stronger. Your character is whatever you spent your time on.",
    shot: "GIF: the masteries panel going up after a fight",
  },
  {
    title: "Animals live their own lives",
    body: "Wolves hunt deer. Some creatures only come out at night. They listen as well as look, so making noise can bring something to you.",
    shot: "GIF: a wolf chasing a deer at dusk",
  },
  {
    title: "Some ruins need friends",
    body: "Under the ground are the ruins of an old city. Some floors only open when enough people stand on the plates at once, and some guardians are too strong for one person.",
    shot: "Screenshot: a group of players on pressure plates underground",
  },
  {
    title: "The world changes",
    body: "Trees burn down. Rivers freeze, and you can walk across them. What you change above ground stays changed.",
    shot: "GIF: fire spreading through a line of trees",
  },
  {
    title: "Phone or computer",
    body: "It runs in the browser. Same world, same people, whichever you pick up. Start on a laptop and carry on from your phone.",
    shot: "Photo: the same character on a phone and a laptop",
  },
];

const GALLERY = [
  "Screenshot: a town by day",
  "Screenshot: a cave by torchlight",
  "Screenshot: casting a stone",
  "Screenshot: a fight",
  "Screenshot: a shop",
  "Screenshot: night falling over a field",
];

export default function HomePage() {
  return (
    <div className="min-h-dvh bg-ink text-paper" style={{ fontFamily: SYSTEM_MONO }}>
      <Hero />
      <main className="mx-auto flex max-w-3xl flex-col gap-24 px-4 py-16 sm:px-6">
        <section className="flex flex-col gap-16">
          {FEATURES.map((feature) => (
            <article key={feature.title} className="flex flex-col gap-4">
              <Heading>{feature.title}</Heading>
              <p className="text-sm leading-relaxed text-paper/80">{feature.body}</p>
              <Shot label={feature.shot} />
            </article>
          ))}
        </section>

        <section className="flex flex-col gap-4">
          <Heading>The story</Heading>
          <div className="flex flex-col gap-4 border-2 border-paper/30 p-5 text-sm leading-relaxed text-paper/80">
            <p>
              A people called the Arcane learned to command nature by writing on stones. Twelve of
              them tried a stone meant to open a door to another world. It joined the two worlds
              into one instead, and what lived on the other side came through.
            </p>
            <p>
              Three survived. Garius froze their city in time, so every sixty days it goes back to
              how it was. Dieter made new people, us, who remember what happens. Holleg turned
              himself into forty metres of earth and buried it all.
            </p>
            <p>
              People still call the ground Holleg. You wake up in the one room left near the
              surface, where Dieter is writing the story on the wall.
            </p>
          </div>
        </section>

        <section className="flex flex-col gap-4">
          <Heading>Pictures</Heading>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {GALLERY.map((label) => (
              <Shot key={label} label={label} />
            ))}
          </div>
        </section>

        <footer className="flex flex-col items-center gap-6 text-center">
          <PlayButtons />
          <p className="text-xs text-paper/40">The Last Stones</p>
        </footer>
      </main>
    </div>
  );
}

/**
 * Full-bleed, with the town walking by behind it.
 *
 * The video is a square recording of the play view with the labels hidden
 * (`scripts/record-hero.ts`), cropped to whatever shape the screen is by
 * `object-cover`. The character is in the middle of every frame. `object-top`
 * is what keeps them out from behind the logo on a wide screen, where the crop
 * is vertical: anchored to the top, the middle of the video lands under the
 * buttons rather than under the words. The poster is its first frame, so the prerendered page shows the
 * town before the video has loaded, and shows it instead of the video to
 * anybody who has asked for less motion.
 *
 * `pixelated` because the recording is the game's own pixels scaled up by a
 * whole number; the browser scaling it again to fit should not smooth them.
 */
function Hero() {
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      if (reduce.matches) element.pause();
      else void element.play().catch(() => {});
    };
    apply();
    reduce.addEventListener("change", apply);
    return () => reduce.removeEventListener("change", apply);
  }, []);

  return (
    <header className="relative isolate flex min-h-[100svh] flex-col items-center justify-center gap-8 overflow-hidden px-4 py-16 text-center">
      <video
        ref={video}
        className="absolute inset-0 -z-20 h-full w-full object-cover object-top"
        style={{ imageRendering: "pixelated" }}
        poster="/home/hero.jpg"
        muted
        loop
        playsInline
        preload="auto"
        aria-hidden="true"
      >
        <source src="/home/hero.webm" type="video/webm" />
        <source src="/home/hero.mp4" type="video/mp4" />
      </video>
      {/* Darkens the town enough that the words over it read, and fades the
          bottom edge into the page so the section does not end on a hard line. */}
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-ink/70 via-ink/40 to-ink" />
      <DoorLogo />
      <p
        className="text-[20px] leading-[30px] text-paper [text-shadow:2px_2px_0_#1a1a1a]"
        style={{ fontFamily: PIXEL }}
      >
        A small MMO that runs in your browser.
      </p>
      <p className="max-w-md text-sm leading-relaxed text-paper/90 [text-shadow:1px_1px_0_#1a1a1a]">
        Walk around, fight, cast, trade and explore with other people. On your phone or your
        computer, in the same world.
      </p>
      <PlayButtons />
    </header>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <h2
      className="text-[20px] leading-[30px] text-[#ffd23f] sm:text-[40px] sm:leading-[50px]"
      style={{ fontFamily: PIXEL }}
    >
      {children}
    </h2>
  );
}

/**
 * Both ways in. `/` rather than `/sign-in` for playing, because the game's own
 * loader already sends a visitor to whichever screen they are missing — the
 * sign-in form, the character list, or straight into the world.
 */
function PlayButtons() {
  return (
    <div className="flex flex-wrap justify-center gap-4">
      <Link
        to="/"
        className="border-2 border-ink bg-interact px-6 py-3 text-xs uppercase tracking-widest text-ink shadow-[4px_4px_0_0_#f4f0e6] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[2px_2px_0_0_#f4f0e6]"
      >
        Play now
      </Link>
      <Link
        to="/sign-up"
        className="border-2 border-paper px-6 py-3 text-xs uppercase tracking-widest text-paper hover:bg-paper hover:text-ink"
      >
        Make an account
      </Link>
    </div>
  );
}

/** A stand-in for a screenshot that has not been taken yet. */
function Shot({ label }: { label: string }) {
  return (
    <div className="flex aspect-[16/10] w-full items-center justify-center border-2 border-dashed border-paper/30 p-4 text-center text-xs leading-relaxed text-paper/40">
      {label}
    </div>
  );
}
