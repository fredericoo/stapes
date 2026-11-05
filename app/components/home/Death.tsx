import { sprite } from "./content";

export function Death() {
  return (
    <section id="death" className="home-death" aria-labelledby="death-title">
      <h2 id="death-title" className="home-pixel home-section-title">
        Dying costs you
      </h2>
      <div className="home-death-body">
        <figure className="home-death-art">
          <img src={sprite("death-skull")} alt="" className="pixelated" />
          <figcaption>Wren I's skull</figcaption>
        </figure>
        <div className="home-death-text">
          <p>
            When you die, your bag falls where you died with everything in it, for anybody to pick
            up, and your skull is left beside it. You keep everything you were wearing and holding.
          </p>
          <p>
            Every mastery loses a tenth of its experience, which can cost you levels. You come back
            at the start with a new, empty bag, and with a torch, a rusty sword and a cloth tunic if
            you had lost them.
          </p>
          <p>Quest chests give their reward once per character. Dying does not refill them.</p>
        </div>
      </div>
    </section>
  );
}
