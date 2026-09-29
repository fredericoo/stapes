import { type CSSProperties, type ReactNode, useRef } from "react";
import { SYSTEM_MONO } from "../components/door";
import { FeatureTour } from "../components/home/FeatureTour";
import { FinalCall } from "../components/home/FinalCall";
import { Gallery } from "../components/home/Gallery";
import { media } from "../components/home/content";
import { Hero } from "../components/home/Hero";
import { NAV_HEIGHT_PX, NavBar } from "../components/home/NavBar";
import { PlaybackProvider, usePlayback } from "../components/home/playback";
import { Story } from "../components/home/Story";
import { useOnScreen } from "../components/home/useOnScreen";
import type { Route } from "./+types/home";
import "./home.css";

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

/**
 * NF Pixels is `font-display: block`, so the headings are invisible until it
 * arrives. Preloading it keeps that gap short on a page that is read first.
 */
export const links: Route.LinksFunction = () => [
  {
    rel: "preload",
    href: "/fonts/nf-pixels-ascii.woff2",
    as: "font",
    type: "font/woff2",
    crossOrigin: "anonymous",
  },
  { rel: "preload", href: media("hero.jpg"), as: "image", fetchPriority: "high" },
];

/**
 * The bar comes in once the hero's bottom edge rises above a line 12% of the
 * way down the screen: the margin takes that top band off the viewport, and
 * the hero stops being in what is left.
 */
const NAV_REVEAL_MARGIN = "-12% 0px 0px 0px";

const PAGE_STYLE: CSSProperties = { fontFamily: SYSTEM_MONO, "--home-nav-h": `${NAV_HEIGHT_PX}px` };

export default function HomePage() {
  const heroRef = useRef<HTMLElement>(null);
  const heroInBand = useOnScreen(heroRef, { rootMargin: NAV_REVEAL_MARGIN, initial: true });

  return (
    <PlaybackProvider>
      <HomeRoot>
        <NavBar shown={!heroInBand} />
        <Hero heroRef={heroRef} />
        <main>
          <FeatureTour />
          <Story />
          <Gallery />
          <FinalCall />
        </main>
        <footer className="home-footer">The Last Stones</footer>
      </HomeRoot>
    </PlaybackProvider>
  );
}

/** `data-playing` lets the page's own looping animations stop with the videos. */
function HomeRoot({ children }: { children: ReactNode }) {
  const { playing } = usePlayback();
  return (
    <div className="home" style={PAGE_STYLE} data-playing={playing}>
      {children}
    </div>
  );
}
