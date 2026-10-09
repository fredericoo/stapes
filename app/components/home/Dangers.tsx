import { DANGERS } from "./content";

export function Dangers() {
  return (
    <section id="dangers" className="home-dangers" aria-labelledby="dangers-title">
      <h2 id="dangers-title" className="home-pixel home-section-title">
        It is a hard game
      </h2>
      <p className="home-dangers-lede">
        The world does not go easy on you. A new character has little health, and it does not come
        back on its own: you eat, sleep or heal to get it back. Most things out there can kill you.
      </p>
      <ul className="home-dangers-list" role="list">
        {DANGERS.map((danger) => (
          <li key={danger.id} className="home-danger">
            <div className="home-danger-art" aria-hidden="true">
              <img
                src={danger.sprite}
                alt=""
                className="pixelated"
                style={{ "--w": danger.widthCells, "--h": danger.heightCells }}
              />
            </div>
            <h3 className="home-pixel home-danger-title">{danger.title}</h3>
            <p className="home-danger-body">{danger.body}</p>
          </li>
        ))}
      </ul>
      <p className="home-dangers-death">
        <strong>Death is final.</strong> Everything you carried and wore falls where you died, every
        skill starts over, and you wake up in the tutorial as the next of your line: Wren I comes
        back as Wren II. Only your name and your deaths carry over.
      </p>
    </section>
  );
}
