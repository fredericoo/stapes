import { useEffect, useRef, useState } from "react";
import { BrickStar } from "./BrickStar";

type Rise = { seq: number; rating: number };

const SPARK_DIRECTIONS = [
  [0, -1],
  [0.71, -0.71],
  [1, 0],
  [0.71, 0.71],
  [0, 1],
  [-0.71, 0.71],
  [-1, 0],
  [-0.71, -0.71],
] as const;

/**
 * Remembers the rating across renders and reports a rise only between two live
 * readings, so the first snapshot after joining or reconnecting, which replaces
 * the empty placeholder, is not mistaken for one.
 */
function useRatingRise(rating: number | null, live: boolean): [Rise | null, () => void] {
  const [rise, setRise] = useState<Rise | null>(null);
  const previous = useRef({ rating, live });

  useEffect(() => {
    const prev = previous.current;
    previous.current = { rating, live };
    if (!prev.live || !live || prev.rating === null || rating === null) return;
    if (rating <= prev.rating) return;
    setRise((last) => ({ seq: (last?.seq ?? 0) + 1, rating }));
  }, [rating, live]);

  return [rise, () => setRise(null)];
}

export function RatingUpBanner({ rating, live }: { rating: number | null; live: boolean }) {
  const [rise, dismiss] = useRatingRise(rating, live);

  return (
    <div className="world-label-layer">
      {rise ? (
        <div
          key={rise.seq}
          className="rating-up"
          role="status"
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) dismiss();
          }}
        >
          <span className="rating-up__burst" aria-hidden="true">
            <span className="rating-up__ring" />
            {SPARK_DIRECTIONS.map(([dx, dy]) => (
              <span
                key={`${dx},${dy}`}
                className="rating-up__spark"
                style={{ "--dx": dx, "--dy": dy } as React.CSSProperties}
              />
            ))}
            <BrickStar className="rating-up__star" />
          </span>
          <span className="rating-up__title">Rating up</span>
          <span className="rating-up__value">
            <span className="sr-only">Your rating is now </span>
            {rise.rating}
          </span>
        </div>
      ) : null}
    </div>
  );
}
