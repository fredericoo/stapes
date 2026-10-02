import { Link } from "react-router";
import { DISCORD_INVITE } from "./content";

export function PlayButtons() {
  return (
    <div className="home-buttons">
      <Link to="/guest" className="home-btn home-btn--primary">
        Play now
      </Link>
      <a
        href={DISCORD_INVITE}
        rel="noreferrer"
        target="_blank"
        className="home-btn home-btn--secondary"
      >
        Join on Discord
      </a>
    </div>
  );
}
