import { redirect, useLoaderData, useNavigate, useRevalidator } from "react-router";
import { SaveCharacterButton } from "../components/SaveCharacterButton";
import { WorldPage } from "../components/WorldPage";
import { fetchMe } from "../lib/auth";
import { forgetCharacter, resolveRemembered } from "../lib/playing";
import { onlineLink } from "../net/link";
import { usePlayerShell } from "./player";

export async function clientLoader() {
  const me = await fetchMe();
  if (!me.user) throw redirect("/sign-in");
  const character = resolveRemembered(me.characters);
  if (!character) throw redirect("/characters");
  return { character, admin: me.user.role === "ADMIN", guest: me.user.guest };
}

export default function GamePage() {
  const { character, admin, guest } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const { tiles, tilesets, statuses } = usePlayerShell();
  const navigate = useNavigate();

  const leave = () => {
    forgetCharacter();
    void navigate("/characters");
  };

  return (
    <WorldPage
      key={character.id}
      link={onlineLink}
      admin={admin}
      lightingToggle={admin}
      tiles={tiles}
      tilesets={tilesets}
      statuses={statuses}
      menuExtras={
        guest ? (
          <div className="py-2">
            <SaveCharacterButton onSaved={() => void revalidator.revalidate()} />
          </div>
        ) : null
      }
      menuAttention={guest}
      onLeave={leave}
      onRefused={leave}
    />
  );
}
