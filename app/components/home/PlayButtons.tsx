import { Link } from "react-router";

export function PlayButtons() {
  return (
    <div className="home-buttons">
      <Link to="/guest" className="home-btn home-btn--primary">
        Play now
      </Link>
      <Link to="/sign-up" className="home-btn home-btn--secondary">
        Create account
      </Link>
    </div>
  );
}
