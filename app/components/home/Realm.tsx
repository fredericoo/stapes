import { useEffect, useState } from "react";
import { fetchRealm } from "../../lib/api";
import { IconStar } from "../pixelIcons";
import type { RealmState } from "../../../server/realm";

const REFRESH_MS = 30_000;

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
        Highest rated
      </h2>
      <p className="home-realm-lede">
        The three highest-rated characters. Dying costs experience, and that can be enough to lose a
        place here.
      </p>
      <ol className="home-realm-list" role="list">
        {realm.leaders.map((leader, index) => (
          <li key={leader.name} className="home-realm-entry">
            <span className="home-pixel home-realm-rank">{index + 1}</span>
            <span className="home-pixel home-realm-name">{leader.name}</span>
            <span className="home-realm-rating" aria-label={`Rating ${leader.rating}`}>
              <IconStar size={12} aria-hidden="true" />
              {leader.rating}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
