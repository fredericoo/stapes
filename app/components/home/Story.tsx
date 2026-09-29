import { useEffect, useRef, useState } from "react";
import { BURIED_DEPTH_M, media, sprite, STORY, type StoryScene } from "./content";

/**
 * The earth rises while the frozen city's paragraph is up, starting this share
 * of the scroll after that paragraph arrives and finishing this share before
 * the next one does.
 */
const EARTH_INSET = 0.03;

const WAKE_ROOM = { src: media("story-wake.webp"), px: 576 };
const PORTAL_PX = 16;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** The stretch of the scroll, from 0 to 1, over which `scene`'s paragraph is up. */
function spanOf(scene: StoryScene): { from: number; to: number } {
  const index = STORY.findIndex((beat) => beat.scene === scene);
  return { from: STORY[index]?.from ?? 0, to: STORY[index + 1]?.from ?? 1 };
}

const FROZEN = spanOf("frozen");
const EARTH_FROM = FROZEN.from + EARTH_INSET;
const EARTH_TO = FROZEN.to - EARTH_INSET;

/** 0 when the section's top reaches the top of the viewport, 1 when its bottom reaches the bottom. */
function scrollProgress(track: HTMLElement): number {
  const rect = track.getBoundingClientRect();
  const travel = rect.height - window.innerHeight;
  return travel <= 0 ? 1 : clamp01(-rect.top / travel);
}

function beatAt(progress: number): number {
  return STORY.reduce((found, beat, index) => (progress >= beat.from ? index : found), 0);
}

/** Calls `onFrame` once a frame while the page scrolls or resizes, and only while `target` is on screen. */
function onScrollWhileVisible(target: Element, onFrame: () => void): () => void {
  let frame = 0;
  let listening = false;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      onFrame();
    });
  };
  const stop = () => {
    window.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
  };
  const observer = new IntersectionObserver((entries) => {
    const visible = entries.at(-1)?.isIntersecting ?? false;
    if (visible === listening) return;
    listening = visible;
    schedule();
    if (!visible) {
      stop();
      return;
    }
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
  });
  observer.observe(target);
  return () => {
    observer.disconnect();
    stop();
    cancelAnimationFrame(frame);
  };
}

type Drawn = { earth: number; depth: number };

/** Writes how far the earth has risen, skipping whichever value has not changed since `drawn`. */
function drawEarth(stage: HTMLElement, gauge: HTMLElement | null, earth: number, drawn: Drawn) {
  if (earth !== drawn.earth) {
    stage.style.setProperty("--story-earth", String(earth));
    drawn.earth = earth;
  }
  const depth = Math.round(earth * BURIED_DEPTH_M);
  if (!gauge || depth === drawn.depth) return;
  gauge.textContent = String(depth);
  drawn.depth = depth;
}

/**
 * Draws the story for the current scroll and returns the paragraph that is up.
 * Where `home.css` has laid it out still, because the visitor asked for less
 * motion or the screen is too short for the stage, the stage is not sticky,
 * and the story is drawn finished.
 */
function drawStory(
  track: HTMLElement,
  stage: HTMLElement,
  gauge: HTMLElement | null,
  drawn: Drawn,
): number {
  const scrolled = getComputedStyle(stage).position === "sticky";
  const progress = scrolled ? scrollProgress(track) : 1;
  const earth = clamp01((progress - EARTH_FROM) / (EARTH_TO - EARTH_FROM));
  drawEarth(stage, gauge, earth, drawn);
  return beatAt(progress);
}

/**
 * The paragraphs of the story, told over a city that is frozen and then
 * buried. Scrolling writes `--story-earth` onto the stage and the depth into
 * the gauge directly, so it re-renders nothing; React hears about it only when
 * the paragraph changes.
 */
export function Story() {
  const trackRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const depthRef = useRef<HTMLSpanElement>(null);
  const [beat, setBeat] = useState(0);

  useEffect(() => {
    const track = trackRef.current;
    const stage = stageRef.current;
    if (!track || !stage) return;
    const drawn: Drawn = { earth: -1, depth: -1 };
    const stop = onScrollWhileVisible(track, () =>
      setBeat(drawStory(track, stage, depthRef.current, drawn)),
    );
    return () => {
      stop();
      stage.style.removeProperty("--story-earth");
    };
  }, []);

  const scene = (STORY[beat] ?? STORY[0]!).scene;

  return (
    <section id="story" className="home-story" aria-labelledby="story-title">
      <div ref={trackRef} className="home-story-track">
        <div ref={stageRef} className="home-story-stage" data-scene={scene}>
          <div className="home-story-sky" aria-hidden="true">
            <span className="home-story-stars" />
            <img
              src={sprite("portal")}
              alt=""
              width={PORTAL_PX}
              height={PORTAL_PX}
              className="pixelated home-story-portal"
            />
          </div>
          <City />
          <div className="home-story-earth" aria-hidden="true">
            <div className="home-story-room">
              <img
                src={WAKE_ROOM.src}
                alt=""
                width={WAKE_ROOM.px}
                height={WAKE_ROOM.px}
                loading="lazy"
                decoding="async"
                className="pixelated"
              />
            </div>
          </div>
          <div className="home-story-gauge" aria-hidden="true">
            <span>Holleg</span>
            <span className="home-story-gauge-bar">
              <span className="home-story-gauge-fill" />
            </span>
            <span className="home-pixel home-story-gauge-value home-outline">
              <span ref={depthRef}>0</span>m
            </span>
          </div>

          <div className="home-story-copy">
            <h2 id="story-title" className="home-pixel home-section-title">
              The story
            </h2>
            <ol className="home-story-beats" role="list">
              {STORY.map(({ text }, index) => (
                <li key={text} data-active={index === beat}>
                  {text}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * The skyline is drawn on a grid of this many units and scaled to cover the
 * stage, so a unit is several screen pixels and not always a whole number of
 * them; `crispEdges` keeps every edge hard regardless.
 */
const SKYLINE_WIDTH = 160;
const SKYLINE_HEIGHT = 56;

type Building = { x: number; width: number; height: number };

const BUILDINGS: Building[] = [
  { x: 0, width: 14, height: 18 },
  { x: 12, width: 9, height: 30 },
  { x: 20, width: 16, height: 22 },
  { x: 34, width: 6, height: 44 },
  { x: 39, width: 18, height: 26 },
  { x: 56, width: 12, height: 34 },
  { x: 67, width: 20, height: 20 },
  { x: 72, width: 8, height: 50 },
  { x: 86, width: 14, height: 28 },
  { x: 99, width: 10, height: 38 },
  { x: 108, width: 18, height: 24 },
  { x: 124, width: 7, height: 46 },
  { x: 130, width: 16, height: 30 },
  { x: 145, width: 15, height: 20 },
];

const WINDOW_STEP = 4;
const WINDOW_MARGIN = 2;
const LIT_EVERY = 3;
const LIT_HASH_X = 7;
const LIT_HASH_Y = 3;

/**
 * Which windows are lit is a fixed pattern of the window's own position, so
 * the prerendered page and the one React hydrates draw the same city.
 */
function windowsOf({ x, width, height }: Building): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const top = SKYLINE_HEIGHT - height + WINDOW_MARGIN + 1;
  for (let wx = x + WINDOW_MARGIN; wx < x + width - WINDOW_MARGIN; wx += WINDOW_STEP) {
    for (let wy = top; wy < SKYLINE_HEIGHT - WINDOW_MARGIN; wy += WINDOW_STEP) {
      if ((wx * LIT_HASH_X + wy * LIT_HASH_Y) % LIT_EVERY === 0) out.push({ x: wx, y: wy });
    }
  }
  return out;
}

function City() {
  return (
    <svg
      className="home-story-city"
      viewBox={`0 0 ${SKYLINE_WIDTH} ${SKYLINE_HEIGHT}`}
      preserveAspectRatio="xMidYMax slice"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {BUILDINGS.map((building) => (
        <g key={building.x}>
          <rect
            x={building.x}
            y={SKYLINE_HEIGHT - building.height}
            width={building.width}
            height={building.height}
            className="home-story-building"
          />
          {windowsOf(building).map((spot) => (
            <rect
              key={`${spot.x},${spot.y}`}
              x={spot.x}
              y={spot.y}
              width={1}
              height={1}
              className="home-story-window"
            />
          ))}
        </g>
      ))}
    </svg>
  );
}
