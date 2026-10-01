import type { CSSProperties, RefObject } from "react";
import { DoorLogo } from "../door";
import { media } from "./content";
import { LoopVideo, PlaybackToggle } from "./playback";
import { PlayButtons } from "./PlayButtons";
import { useOnScreen } from "./useOnScreen";

/** The MP4 is the smaller file; the WebM is there for a browser without H.264. */
const HERO_SOURCES = [
  { src: media("hero.mp4"), type: "video/mp4" },
  { src: media("hero.webm"), type: "video/webm" },
];

/** The order the hero's parts rise into place in, a tenth of a second apart. */
const RISE_ORDER = { logo: 0, stage: 1, tagline: 2, lede: 3, buttons: 4, cue: 5 } as const;

function rise(part: keyof typeof RISE_ORDER): CSSProperties {
  return { "--rise-order": RISE_ORDER[part] };
}

export function Hero({ heroRef }: { heroRef: RefObject<HTMLElement | null> }) {
  const onScreen = useOnScreen(heroRef);
  return (
    <header ref={heroRef} id="top" className="home-hero">
      <div className="home-hero-media" aria-hidden="true">
        <LoopVideo
          sources={HERO_SOURCES}
          poster={media("hero.jpg")}
          active={onScreen}
          className="home-hero-video pixelated"
        />
      </div>
      <div className="home-hero-shade" aria-hidden="true" />

      <div className="home-hero-lift">
        <h1 className="home-rise" style={rise("logo")}>
          <DoorLogo />
        </h1>
        <p className="home-rise home-pixel home-alpha-badge" style={rise("stage")}>
          Alpha
        </p>
        <p className="home-rise home-pixel home-tagline home-outline" style={rise("tagline")}>
          A small MMO that runs in your browser.
        </p>
        <p className="home-rise home-hero-lede" style={rise("lede")}>
          Walk around, fight, cast, trade and explore with other people. On your phone or your
          computer, in the same world. Be warned: it is hard, and{" "}
          <a href="#dangers" className="home-hero-warning">
            most things can kill you
          </a>
          .
        </p>
        <div className="home-rise" style={rise("buttons")}>
          <PlayButtons />
        </div>
      </div>

      <a href="#features" className="home-scroll-cue home-rise" style={rise("cue")}>
        <span>See it played</span>
        <svg
          viewBox="0 0 10 6"
          width="20"
          height="12"
          aria-hidden="true"
          shapeRendering="crispEdges"
        >
          <path d="M0 0h2v2h2v2h2V2h2V0h2v2H8v2H6v2H4V4H2V2H0z" fill="currentColor" />
        </svg>
      </a>
      <PlaybackToggle className="home-hero-toggle" />
    </header>
  );
}
