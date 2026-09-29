import { useState } from "react";
import { useLoaderData } from "react-router";
import { ADMIN_DESTINATIONS, MenuRow } from "../../components/AppShell";
import { WorldPage } from "../../components/WorldPage";
import { fetchBootstrap } from "../../lib/api";
import { requireAdmin } from "../../lib/auth";
import { localLink } from "../../local/link";

export async function clientLoader() {
  await requireAdmin();
  return await fetchBootstrap();
}

export default function PlayPage() {
  const { tiles, tilesets, statuses } = useLoaderData<typeof clientLoader>();
  return (
    <WorldPage
      link={localLink}
      tiles={tiles}
      tilesets={tilesets}
      statuses={statuses}
      destinations={ADMIN_DESTINATIONS}
      menuExtras={
        <MenuRow label="World">
          <ResetWorldButton />
        </MenuRow>
      }
    />
  );
}

function ResetWorldButton() {
  const [asking, setAsking] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        if (!asking) return setAsking(true);
        setAsking(false);
        void localLink.reset?.();
      }}
      onBlur={() => setAsking(false)}
      className="border-2 border-paper/40 px-2 py-1 text-xs uppercase text-paper hover:border-paper"
    >
      {asking ? "Sure? Everything goes" : "Reset world"}
    </button>
  );
}
