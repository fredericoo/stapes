import { useRef } from "react";
import { DoorLogo } from "../door";
import { media } from "./content";
import { LoopVideo, PlaybackToggle } from "./playback";
import { PlayButtons } from "./PlayButtons";
import { useNear, useOnScreen } from "./useOnScreen";

const NIGHTFALL = [{ src: media("nightfall.mp4"), type: "video/mp4" }];

/** Fetch the closing footage a screen before it scrolls into view. */
const LOAD_AHEAD = "100% 0px 100% 0px";

export function FinalCall() {
  const ref = useRef<HTMLElement>(null);
  const near = useNear(ref, LOAD_AHEAD);
  const onScreen = useOnScreen(ref);
  return (
    <section ref={ref} className="home-final" aria-labelledby="final-title">
      <div className="home-final-media" aria-hidden="true">
        <LoopVideo
          sources={NIGHTFALL}
          poster={media("nightfall.webp")}
          active={onScreen}
          load={near ? "footage" : "nothing"}
          className="home-final-video pixelated"
        />
      </div>
      <div className="home-final-shade" aria-hidden="true" />
      <div className="home-final-content">
        <h2 id="final-title">
          <DoorLogo />
        </h2>
        <p className="home-pixel home-tagline home-outline">
          A small MMO that runs in your browser.
        </p>
        <PlayButtons />
      </div>
      <PlaybackToggle className="home-final-toggle" />
    </section>
  );
}
