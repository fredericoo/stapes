import { Link } from "react-router";

export function PlayButtons() {
  return (
    <div className="home-buttons">
      <Link to="/online" className="home-btn home-btn--primary">
        Play now
      </Link>
    </div>
  );
}
