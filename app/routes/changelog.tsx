import type { CSSProperties } from "react";
import changelogMarkdown from "../../CHANGELOG.md?raw";
import { SYSTEM_MONO } from "../components/door";
import { CANONICAL_ORIGIN } from "../components/home/content";
import { NAV_HEIGHT_PX, NavBar } from "../components/home/NavBar";
import { PlayButtons } from "../components/home/PlayButtons";
import { parseChangelog } from "../lib/changelog";
import type { Route } from "./+types/changelog";
import "./home.css";

const TITLE = "What changed · The Last Stones";
const DESCRIPTION = "Everything that changed in The Last Stones, release by release.";

const RELEASES = parseChangelog(changelogMarkdown);

const PAGE_STYLE: CSSProperties = { fontFamily: SYSTEM_MONO, "--home-nav-h": `${NAV_HEIGHT_PX}px` };

export function meta(): Route.MetaDescriptors {
  return [
    { title: TITLE },
    { name: "description", content: DESCRIPTION },
    { tagName: "link", rel: "canonical", href: `${CANONICAL_ORIGIN}/changelog` },
  ];
}

export default function ChangelogPage() {
  return (
    <div className="home" style={PAGE_STYLE}>
      <NavBar shown nameHref="/" />
      <main className="home-changelog">
        <h1 className="home-pixel home-section-title home-outline">What changed</h1>
        {RELEASES.length === 0 ? (
          <p className="home-changelog-empty">
            Nothing yet. The first release will be listed here.
          </p>
        ) : (
          RELEASES.map((release) => (
            <section
              key={release.version}
              className="home-changelog-release"
              aria-labelledby={`v${release.version}`}
            >
              <h2 id={`v${release.version}`} className="home-pixel home-changelog-version">
                v{release.version}
              </h2>
              {release.sections.map((section, sectionIndex) => (
                <div key={sectionIndex}>
                  <h3 className="home-changelog-kind">{section.title}</h3>
                  <ul className="home-changelog-entries">
                    {section.entries.map((entry, entryIndex) => (
                      <li key={entryIndex}>{entry}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))
        )}
        <PlayButtons />
      </main>
    </div>
  );
}
