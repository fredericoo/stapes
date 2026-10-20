import { useEffect, useState } from "react";
import { fetchRealm } from "../../lib/api";
import { RATING_GLYPH } from "../../lib/mastery";
import type { RealmState } from "../../../server/realm";

const REFRESH_MS = 30_000;

const CROWNED_ON = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/**
 * The page is prerendered, so the standings are fetched once it is in a tab,
 * and again while the tab is visible. Until they arrive, and if they never do,
 * nothing is drawn: the hero fills the first screen, so nobody sees it appear.
 */
export function Realm() {
  const [realm, setRealm] = useState<RealmState | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => {
      if (document.hidden) return;
      fetchRealm().then(
        (state) => live && setRealm(state),
        () => {},
      );
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);

  if (!realm || realm.leaders.length === 0) return null;

  return (
    <section id="realm" className="home-realm" aria-labelledby="realm-title">
      <h2 id="realm-title" className="home-pixel home-section-title">
        Who rules
      </h2>
      <p className="home-realm-lede">
        The highest-rated character alive is king. When the king dies, the crown passes to the next
        in line.
      </p>
      <ol className="home-realm-list" role="list">
        {realm.leaders.map((leader, index) => {
          const king = index === 0 && realm.king;
          return (
            <li key={leader.name} className="home-realm-entry" data-king={Boolean(king)}>
              <span className="home-pixel home-realm-rank">{index + 1}</span>
              <span className="home-realm-who">
                <span className="home-pixel home-realm-name">{leader.name}</span>
                {king && (
                  <span className="home-realm-title">
                    King since {CROWNED_ON.format(king.since)}
                  </span>
                )}
              </span>
              <span className="home-realm-rating" aria-label={`Rating ${leader.rating}`}>
                {RATING_GLYPH}
                {leader.rating}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
