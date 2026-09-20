import { useState } from "react";
import { Link, redirect, useLoaderData, useNavigate } from "react-router";
import {
  Door,
  DoorButton,
  DoorNote,
  DoorTitle,
  SYSTEM_MONO,
} from "../components/door";
import { MAX_CHARACTERS_PER_ACCOUNT } from "../lib/characterName";
import { fetchMe, signOut } from "../lib/auth";
import { forgetCharacter, rememberCharacter } from "../lib/playing";
import type { Character } from "../../server/characters";

/**
 * Which body to be, for an account that may hold three.
 *
 * **The second door, and the one the world opens behind.** Signing in proves
 * who the account is; this decides which of its characters the world is about
 * to seat. Pressing a row writes the choice down and navigates to `/` — the id
 * rides the socket from there, checked against the session, never trusted.
 * @see `../lib/playing` and `server/index.ts`
 *
 * **It is also the account's own screen.** Sign out and Change password are
 * reachable from here and from nowhere else: you sign in and out of an
 * *account*, and a *character* enters and leaves the world, so the game's menu
 * offers only the second. Keeping the two vocabularies on two screens is what
 * stops them collapsing into one word.
 * @see `docs/notes.md`, "An account signs in; a character enters"
 *
 * Making one is its own route. This screen's job is to get somebody into the
 * world, and a form sitting under the list is paperwork in front of the button
 * they came for.
 */
export async function clientLoader() {
  const me = await fetchMe();
  if (!me.user) throw redirect("/sign-in");
  return { username: me.user.username, characters: me.characters };
}

export default function CharactersPage() {
  const { username, characters } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  /**
   * Which row was pressed.
   *
   * The press starts a navigation, and a navigation is not instant: the world's
   * own loader has to answer first. Saying so on the row that was pressed is
   * what stops the screen looking like it ignored the press.
   */
  const [entering, setEntering] = useState<string | null>(null);

  const enter = (character: Character) => {
    setEntering(character.id);
    rememberCharacter(character);
    void navigate("/");
  };

  const leave = () => {
    // Before the request, so a tab that is signed out cannot navigate back into
    // a body it no longer has an account for.
    forgetCharacter();
    void signOut().then(() => void navigate("/sign-in"));
  };

  const full = characters.length >= MAX_CHARACTERS_PER_ACCOUNT;

  return (
    <Door>
      <DoorTitle>Signed in as {username}</DoorTitle>

      {characters.length > 0 ? (
        <ul className="flex w-full max-w-xs flex-col gap-2">
          {characters.map((character) => (
            <li key={character.id}>
              <DoorButton
                className="w-full"
                disabled={entering !== null}
                onClick={() => enter(character)}
              >
                {entering === character.id ? "Entering…" : character.name}
              </DoorButton>
            </li>
          ))}
        </ul>
      ) : (
        <DoorNote>
          This account has no characters yet. One is all it takes to get in.
        </DoorNote>
      )}

      {full ? (
        <DoorNote>
          An account holds {MAX_CHARACTERS_PER_ACCOUNT} characters, and this one
          is full.
        </DoorNote>
      ) : (
        <DoorLink to="/characters/new" disabled={entering !== null}>
          New character
        </DoorLink>
      )}

      {/* The account's own two controls, and the only two anywhere. Set apart
          from the link above them, which is about characters: three identical
          links in a row would read as one list of unrelated things. */}
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

/**
 * A quiet link in the door's voice.
 *
 * `aria-disabled` and a swallowed press rather than not rendering it: the three
 * of these are the only things on this screen while a character is entering,
 * and a screen that lost half its content on a press would read as having
 * navigated somewhere.
 */
function DoorLink({
  to,
  disabled,
  children,
}: {
  to: string;
  disabled: boolean;
  children: string;
}) {
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
