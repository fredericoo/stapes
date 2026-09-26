import { redirect, useLoaderData, useNavigate } from "react-router";
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
  return { character, admin: me.user.role === "ADMIN" };
}

export default function GamePage() {
  const { character, admin } = useLoaderData<typeof clientLoader>();
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
      tiles={tiles}
      tilesets={tilesets}
      statuses={statuses}
      onLeave={leave}
      onRefused={leave}
    />
  );
}
