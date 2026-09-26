import { PROTOCOL_VERSION } from "../net/protocol";

const SYSTEM_MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

export function OutdatedScreen({ serverVersion }: { serverVersion: number | null }) {
  const serverBehind = serverVersion !== null && serverVersion < PROTOCOL_VERSION;

  return (
    <div
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-ink p-6 text-center"
      role="alert"
      style={{ fontFamily: SYSTEM_MONO }}
    >
      <span className="text-xs uppercase tracking-widest text-paper">
        {serverBehind ? "The server is out of date" : "This tab is out of date"}
      </span>
      <p className="max-w-sm text-xs leading-relaxed text-paper/70">
        {serverBehind
          ? `This page speaks version ${PROTOCOL_VERSION} and the server speaks ${serverVersion}, so it is the server that has to catch up. Reloading will not help.`
          : `The world has moved on to a newer version of the game. Reloading did not pick it up, which usually means a cached copy of this page.`}
      </p>
      {serverBehind ? null : (
        <button
          type="button"
          autoFocus
          onClick={() => window.location.reload()}
          className="border-2 border-paper px-3 py-1.5 text-xs uppercase tracking-widest text-paper hover:bg-paper hover:text-ink"
          style={{ fontFamily: SYSTEM_MONO }}
        >
          Reload
        </button>
      )}
    </div>
  );
}
