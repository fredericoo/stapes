import { useState } from "react";
import { Link, redirect, useLoaderData, useNavigate } from "react-router";
import { Door, DoorButton, DoorNote, DoorTitle, SYSTEM_MONO } from "../components/door";
import { MAX_CHARACTERS_PER_ACCOUNT } from "../lib/characterName";
import { fetchMe, signOut } from "../lib/auth";
import { forgetCharacter, rememberCharacter } from "../lib/playing";
import type { Character } from "../../server/characters";

export async function clientLoader() {
  const me = await fetchMe();
  if (!me.user) throw redirect("/sign-in");
  return {
    username: me.user.username,
    characters: me.characters,
    maintenance: me.maintenance,
    admin: me.user.role === "ADMIN",
  };
}

export default function CharactersPage() {
  const { username, characters, maintenance, admin } = useLoaderData<typeof clientLoader>();
  const closed = maintenance !== null && !admin;
  const navigate = useNavigate();
  const [entering, setEntering] = useState<string | null>(null);

  const enter = (character: Character) => {
    setEntering(character.id);
    rememberCharacter(character);
    void navigate("/");
  };

  const leave = () => {
    forgetCharacter();
    void signOut().then(() => void navigate("/sign-in"));
  };

  const full = characters.length >= MAX_CHARACTERS_PER_ACCOUNT;

  return (
    <Door>
      <DoorTitle>Signed in as {username}</DoorTitle>

      {maintenance ? (
        <DoorNote>
          {maintenance.message ?? "The world is closed for maintenance."}
          {admin ? " Only administrators can enter." : ""}
        </DoorNote>
      ) : null}

      {characters.length > 0 ? (
        <ul className="flex w-full max-w-xs flex-col gap-2">
          {characters.map((character) => (
            <li key={character.id}>
              <DoorButton
                className="w-full"
                disabled={entering !== null || closed}
                onClick={() => enter(character)}
              >
                {entering === character.id ? "Entering…" : character.name}
              </DoorButton>
            </li>
          ))}
        </ul>
      ) : (
        <DoorNote>This account has no characters yet. One is all it takes to get in.</DoorNote>
      )}

      {full ? (
        <DoorNote>
          An account holds {MAX_CHARACTERS_PER_ACCOUNT} characters, and this one is full.
        </DoorNote>
      ) : (
        <DoorLink to="/characters/new" disabled={entering !== null}>
          New character
        </DoorLink>
      )}

      <div className="mt-3 flex flex-col items-center gap-3">
        <DoorLink to="/account/password" disabled={entering !== null}>
          Change password
        </DoorLink>
        <button
          type="button"
          className="text-xs uppercase tracking-widest text-paper/50 underline underline-offset-4 hover:text-paper disabled:opacity-50"
          style={{ fontFamily: SYSTEM_MONO }}
          disabled={entering !== null}
          onClick={leave}
        >
          Sign out
        </button>
      </div>
    </Door>
  );
}

function DoorLink({ to, disabled, children }: { to: string; disabled: boolean; children: string }) {
  return (
    <Link
      to={to}
      aria-disabled={disabled}
      onClick={(event) => {
        if (disabled) event.preventDefault();
      }}
      className={`text-xs uppercase tracking-widest underline underline-offset-4 ${
        disabled ? "text-paper/25" : "text-paper/50 hover:text-paper"
      }`}
      style={{ fontFamily: SYSTEM_MONO }}
    >
      {children}
    </Link>
  );
}
