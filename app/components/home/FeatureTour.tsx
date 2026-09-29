import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "../../lib/useMediaQuery";
import { type Feature, FEATURES } from "./content";
import { Devices } from "./Devices";
import { LoopVideo, PlaybackToggle, type VideoLoad } from "./playback";
import { useNear, useOnScreen } from "./useOnScreen";

/**
 * The tour begins at the fold, so any lead at all would fetch its footage with
 * the page. It waits until the visitor has scrolled a tenth of a screen in.
 */
const LOAD_MARGIN = "-10% 0px -10% 0px";

/** Footage plays only while some of the tour is in the middle half of the screen. */
const PLAY_BAND = "-25% 0px -25% 0px";

/** Space between the bottom of the stuck screen and the text read under it. */
const READING_GAP_PX = 8;

/** The line a step has to cross to become the one being read, as insets from the viewport's edges. */
type ReadingBand = { topPx: number; bottomPx: number };

/**
 * Where `home.css` sticks the screen column to the top of the page, on a phone,
 * the line is the column's bottom edge, and each step's text sticks there too,
 * so the text being read is never under the screen. Anywhere else, beside the
 * screen or on a screen too short to stick anything, it is the middle of the
 * viewport. The layout is read rather than its breakpoints repeated. Both
 * insets are measured together, on every resize, because a phone's viewport
 * grows and shrinks as its toolbar hides and shows.
 */
function useReadingBand(column: RefObject<HTMLElement | null>): ReadingBand | null {
  const [band, setBand] = useState<ReadingBand | null>(null);

  useEffect(() => {
    const element = column.current;
    if (!element) return;
    const measure = () => {
      const viewportPx = window.innerHeight;
      const style = getComputedStyle(element);
      const lineTop =
        style.position === "sticky"
          ? parseFloat(style.top) + element.offsetHeight + READING_GAP_PX
          : viewportPx / 2;
      const topPx = Math.round(lineTop);
      const bottomPx = Math.max(0, viewportPx - topPx - 1);
      setBand((was) =>
        was?.topPx === topPx && was.bottomPx === bottomPx ? was : { topPx, bottomPx },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [column]);

  return band;
}

/**
 * Reports which of `steps` crosses the reading line. The observer's root is
 * shrunk to the one-pixel band at that line, so a step intersects it exactly
 * while it is the one being read.
 */
function useActiveStep(
  steps: RefObject<(Element | null)[]>,
  band: ReadingBand | null,
  onActive: (index: number) => void,
) {
  useEffect(() => {
    if (!band) return;
    const all = steps.current;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) onActive(all.indexOf(entry.target));
        }
      },
      { rootMargin: `-${band.topPx}px 0px -${band.bottomPx}px 0px` },
    );
    for (const element of all) {
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [steps, band, onActive]);
}

const STONE_PX = 8;

export function FeatureTour() {
  const sectionRef = useRef<HTMLElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const stepRefs = useRef<(HTMLLIElement | null)[]>([]);
  const [active, setActive] = useState(0);
  const reducedMotion = useReducedMotion();
  const near = useNear(sectionRef, LOAD_MARGIN);
  const inPlayBand = useOnScreen(sectionRef, { rootMargin: PLAY_BAND });
  const screenSeen = useOnScreen(screenRef);
  const band = useReadingBand(columnRef);
  useActiveStep(stepRefs, band, setActive);

  /** Focus follows to the step's heading, so a screen reader hears where the press went. */
  const jumpTo = useCallback(
    (index: number) => {
      const step = stepRefs.current[index];
      step?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
      step?.querySelector("h2")?.focus({ preventScroll: true });
    },
    [reducedMotion],
  );

  const current = FEATURES[active] ?? FEATURES[0]!;

  /**
   * The clip on screen and the one after it are fetched ahead, so the next is
   * ready when its step arrives; the rest show their posters until their turn.
   */
  const loadFor = (index: number): VideoLoad => {
    if (!near) return "nothing";
    return index <= active + 1 ? "footage" : "poster";
  };

  return (
    <section
      ref={sectionRef}
      id="features"
      className="home-tour"
      aria-label="What it is like"
      style={band ? { "--home-reading-top": `${band.topPx}px` } : undefined}
    >
      <div ref={columnRef} className="home-tour-screen-col">
        <div className="home-tour-sticky">
          <div ref={screenRef} className="home-screen" aria-hidden="true">
            {FEATURES.map((feature, index) => (
              <ScreenLayer
                key={feature.id}
                feature={feature}
                active={index === active}
                inPlayBand={inPlayBand && screenSeen}
                load={loadFor(index)}
              />
            ))}
          </div>
          <div className="home-screen-bar">
            <StoneRail active={active} onPick={jumpTo} />
            <PlaybackToggle />
          </div>
          <p className="home-pixel home-screen-caption home-outline" aria-hidden="true">
            {current.caption}
          </p>
        </div>
      </div>

      <ol className="home-tour-steps" role="list">
        {FEATURES.map((feature, index) => (
          <li
            key={feature.id}
            ref={(element) => {
              stepRefs.current[index] = element;
            }}
            className="home-step"
            data-active={index === active}
          >
            <StepText feature={feature} index={index} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function ScreenLayer({
  feature,
  active,
  inPlayBand,
  load,
}: {
  feature: Feature;
  active: boolean;
  inPlayBand: boolean;
  load: VideoLoad;
}) {
  const { media } = feature;
  return (
    <div className="home-layer" data-active={active}>
      {media.kind === "video" ? (
        <LoopVideo
          sources={[{ src: media.src, type: "video/mp4" }]}
          poster={media.poster}
          active={active && inPlayBand}
          load={load}
          restart
          className="home-layer-video pixelated"
        />
      ) : (
        <Devices show={load !== "nothing"} />
      )}
    </div>
  );
}

function StoneRail({ active, onPick }: { active: number; onPick: (index: number) => void }) {
  return (
    <ol className="home-rail" role="list" aria-label="Jump to">
      {FEATURES.map((feature, index) => (
        <li key={feature.id}>
          <button
            type="button"
            className="home-rail-stone"
            data-active={index === active}
            aria-current={index === active ? "step" : undefined}
            aria-label={feature.title}
            onClick={() => onPick(index)}
          >
            <img
              src={feature.stone}
              alt=""
              width={STONE_PX}
              height={STONE_PX}
              className="pixelated"
            />
          </button>
        </li>
      ))}
    </ol>
  );
}

function StepText({ feature, index }: { feature: Feature; index: number }) {
  const titleId = `feature-${feature.id}`;
  return (
    <article className="home-step-card" aria-labelledby={titleId}>
      <p className="home-step-eyebrow" aria-hidden="true">
        <img
          src={feature.stone}
          alt=""
          width={STONE_PX}
          height={STONE_PX}
          className="pixelated home-step-stone"
        />
        <span>
          {index + 1} / {FEATURES.length}
        </span>
      </p>
      <h2 id={titleId} className="home-pixel home-step-title" tabIndex={-1}>
        {feature.title}
      </h2>
      <p className="home-step-body">{feature.body}</p>
      <p className="home-step-caption">
        <span className="sr-only">In the footage: </span>
        {feature.caption}
      </p>
    </article>
  );
}
