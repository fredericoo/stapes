import { IconPlayerPauseFilled, IconPlayerPlayFilled } from "@tabler/icons-react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useReducedMotion } from "../../lib/useMediaQuery";

type Playback = {
  playing: boolean;
  setPlaying: (playing: boolean) => void;
};

const PlaybackContext = createContext<Playback>({ playing: false, setPlaying: () => {} });

/**
 * One switch for every video on the page. It starts on unless the visitor has
 * asked for reduced motion, and a press of any pause button settles it either
 * way from then on: looping footage has to be stoppable (WCAG 2.2.2).
 */
export function PlaybackProvider({ children }: { children: ReactNode }) {
  const reducedMotion = useReducedMotion();
  const [chosen, setChosen] = useState<boolean | null>(null);
  const value = useMemo(
    () => ({ playing: chosen ?? !reducedMotion, setPlaying: setChosen }),
    [chosen, reducedMotion],
  );
  return <PlaybackContext.Provider value={value}>{children}</PlaybackContext.Provider>;
}

export function usePlayback(): Playback {
  return useContext(PlaybackContext);
}

type VideoSource = { src: string; type: string };

/**
 * How much of a video to fetch before it is asked to play. With `"nothing"`
 * the sources and poster are left out of the markup; `"poster"` shows the
 * poster and fetches the footage when it plays; `"footage"` fetches it ahead,
 * unless the videos are paused, when it waits to be played like `"poster"`.
 * The prerendered page cannot know whether they will be, since that depends on
 * the visitor's motion setting, so nothing is fetched ahead until it hydrates.
 */
export type VideoLoad = "nothing" | "poster" | "footage";

/**
 * How a browser that will not autoplay (iOS in Low Power Mode, Safari set never
 * to) refuses `play()`. A `pause()` landing first rejects it too, differently.
 */
function isAutoplayRefusal(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotAllowedError";
}

/** A muted loop that plays only while `active` and the page-wide switch is on. */
export function LoopVideo({
  sources,
  poster,
  active,
  load = "footage",
  restart = false,
  className = "",
}: {
  sources: VideoSource[];
  poster: string;
  active: boolean;
  load?: VideoLoad;
  restart?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [hydrated, setHydrated] = useState(false);
  const { playing, setPlaying } = usePlayback();
  const present = load !== "nothing";
  const shouldPlay = active && playing && present;

  useEffect(() => setHydrated(true), []);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (!shouldPlay) {
      video.pause();
      return;
    }
    video.play().catch((error: unknown) => {
      if (isAutoplayRefusal(error)) setPlaying(false);
    });
  }, [shouldPlay, setPlaying]);

  useEffect(() => {
    const video = ref.current;
    if (restart && active && video) video.currentTime = 0;
  }, [restart, active]);

  return (
    <video
      ref={ref}
      className={className}
      poster={present ? poster : undefined}
      muted
      loop
      playsInline
      disablePictureInPicture
      preload={hydrated && load === "footage" && playing ? "auto" : "none"}
      aria-hidden="true"
    >
      {present ? sources.map((source) => <source key={source.src} {...source} />) : null}
    </video>
  );
}

const TOGGLE_ICON_PX = 14;

export function PlaybackToggle({ className = "" }: { className?: string }) {
  const { playing, setPlaying } = usePlayback();
  const Icon = playing ? IconPlayerPauseFilled : IconPlayerPlayFilled;
  return (
    <button
      type="button"
      className={`home-toggle ${className}`}
      onClick={() => setPlaying(!playing)}
      aria-label={playing ? "Pause the videos" : "Play the videos"}
    >
      <Icon size={TOGGLE_ICON_PX} aria-hidden="true" />
      <span aria-hidden="true">{playing ? "Pause" : "Play"}</span>
    </button>
  );
}
