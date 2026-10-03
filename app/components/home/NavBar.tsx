import { Link } from "react-router";
import { DISCORD_INVITE } from "./content";

export const NAV_HEIGHT_PX = 52;

/**
 * Slides in once the hero has scrolled away, so the way in is always one
 * press off, and whenever something in it has focus, so a keyboard reaches
 * "Sign in" from the top of the page.
 */
export function NavBar({ shown, nameHref = "#top" }: { shown: boolean; nameHref?: string }) {
  return (
    <nav aria-label="The Last Stones" className="home-nav" data-shown={shown}>
      <a href={nameHref} className="home-pixel home-nav-name">
        The Last Stones
      </a>
      <div className="home-nav-actions">
        <a href={DISCORD_INVITE} rel="noreferrer" target="_blank" className="home-nav-link">
          Discord
        </a>
        <Link to="/sign-in" className="home-nav-link">
          Sign in
        </Link>
        <Link to="/guest" className="home-btn home-btn--primary home-btn--compact">
          Play now
        </Link>
      </div>
      <div className="home-nav-progress" aria-hidden="true" />
    </nav>
  );
}
