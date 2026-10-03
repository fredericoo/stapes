import { type CSSProperties, type ReactNode, useRef } from "react";
import { Link } from "react-router";
import { SYSTEM_MONO } from "../components/door";
import { Dangers } from "../components/home/Dangers";
import { FeatureTour } from "../components/home/FeatureTour";
import { FinalCall } from "../components/home/FinalCall";
import { Gallery } from "../components/home/Gallery";
import { CANONICAL_ORIGIN, DISCORD_INVITE, media } from "../components/home/content";
import { Hero } from "../components/home/Hero";
import { NAV_HEIGHT_PX, NavBar } from "../components/home/NavBar";
import { PlaybackProvider, usePlayback } from "../components/home/playback";
import { useOnScreen } from "../components/home/useOnScreen";
import type { Route } from "./+types/home";
import "./home.css";

const TITLE = "The Last Stones";
const DESCRIPTION =
  "A small MMO that runs in your browser, on phone or computer. No levels, no classes: you get better at what you do.";

/**
 * The share image is in `public/` under a name with a version in it, not
 * imported: a card keeps pointing at the URL it was scraped with, and a build's
 * hashed files stop being served a few deploys later. A new picture gets a new
 * name.
 */
const SHARE_IMAGE = { src: `${CANONICAL_ORIGIN}/share/landing-1.jpg`, width: 1200, height: 630 };
const MAKER = {
  name: "Freddie",
  profiles: [
    { label: "GitHub", href: "https://github.com/fredericoo" },
    { label: "X", href: "https://x.com/frederic_ooo" },
  ],
};

export function meta(): Route.MetaDescriptors {
  return [
    { title: TITLE },
    { name: "description", content: DESCRIPTION },
    { tagName: "link", rel: "canonical", href: `${CANONICAL_ORIGIN}/` },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: TITLE },
    { property: "og:title", content: TITLE },
    { property: "og:description", content: DESCRIPTION },
    { property: "og:url", content: `${CANONICAL_ORIGIN}/` },
    { property: "og:image", content: SHARE_IMAGE.src },
    { property: "og:image:width", content: String(SHARE_IMAGE.width) },
    { property: "og:image:height", content: String(SHARE_IMAGE.height) },
    {
      property: "og:image:alt",
      content: "The Last Stones logo over the Gilded Barrel inn at midday, in pixel art.",
    },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: TITLE },
    { name: "twitter:description", content: DESCRIPTION },
    { name: "twitter:image", content: SHARE_IMAGE.src },
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
          <Dangers />
          <Gallery />
          <FinalCall />
        </main>
        <footer className="home-footer">
          <p>
            The Last Stones, in alpha ·{" "}
            <a href={DISCORD_INVITE} rel="noreferrer" target="_blank">
              Discord
            </a>
            {" · "}
            <Link to="/changelog">What changed</Link>
          </p>
          <p>
            Made by {MAKER.name}
            {MAKER.profiles.map((profile) => (
              <span key={profile.href}>
                {" · "}
                <a href={profile.href} rel="me noreferrer" target="_blank">
                  {profile.label}
                </a>
              </span>
            ))}
          </p>
        </footer>
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
