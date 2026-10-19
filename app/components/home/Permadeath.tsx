import { sprite } from "./content";

export function Permadeath() {
  return (
    <section id="permadeath" className="home-permadeath" aria-labelledby="permadeath-title">
      <h2 id="permadeath-title" className="home-pixel home-section-title">
        Death is final
      </h2>
      <div className="home-permadeath-body">
        <figure className="home-permadeath-art">
          <img src={sprite("permadeath-skull")} alt="" className="pixelated" />
          <figcaption>Wren I's skull</figcaption>
        </figure>
        <div className="home-permadeath-text">
          <p>
            When you die, that character is gone. Everything you carried and wore falls where you
            died, for anybody to pick up, and your skull is left beside it.
          </p>
          <p>
            You start again in the tutorial as the next of your line: Wren I comes back as Wren II,
            with every skill back at the beginning. Only your name and your deaths carry over.
          </p>
        </div>
      </div>
    </section>
  );
}
