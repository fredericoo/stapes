import { media } from "./content";

type Screenshot = { src: string; width: number; height: number };

const LAPTOP: Screenshot = { src: media("device-laptop.webp"), width: 1280, height: 784 };
const PHONE: Screenshot = { src: media("device-phone.webp"), width: 562, height: 1218 };

export function Devices({ show }: { show: boolean }) {
  return (
    <div className="home-devices">
      <div className="home-laptop">
        <Screen className="home-laptop-screen" shot={LAPTOP} show={show} />
        <div className="home-laptop-base" />
      </div>
      <div className="home-phone">
        <Screen className="home-phone-screen" shot={PHONE} show={show} />
      </div>
    </div>
  );
}

function Screen({ className, shot, show }: { className: string; shot: Screenshot; show: boolean }) {
  return (
    <div className={className} style={{ aspectRatio: `${shot.width} / ${shot.height}` }}>
      {show ? (
        <img src={shot.src} width={shot.width} height={shot.height} alt="" decoding="async" />
      ) : null}
    </div>
  );
}
