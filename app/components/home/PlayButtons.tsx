import { Link } from "react-router";

export function PlayButtons() {
  return (
    <div className="home-buttons">
      <Link to="/online" className="home-btn home-btn--primary">
        Play now
      </Link>
      <Link to="/sign-up" className="home-btn home-btn--secondary">
        Make an account
      </Link>
    </div>
  );
}
