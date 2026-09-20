import { useState } from "react";
import {
  Door,
  DoorButton,
  DoorError,
  DoorField,
  DoorNote,
  DoorTitle,
  SYSTEM_MONO,
} from "./door";
import {
  MAX_CHARACTERS_PER_ACCOUNT,
  MAX_CHARACTER_NAME_LENGTH,
  characterNameProblem,
} from "../lib/characterName";
import { ChangePassword } from "./ChangePassword";
import { createCharacter } from "../lib/auth";
import type { Character } from "../../server/characters";

/**
 * Which body to be, for an account that may hold three.
 *
 * **The second door, and the one the socket opens behind.** Signing in proves
 * who the account is; this decides which of its characters the world is about
 * to seat, and the id it picks rides the socket URL — checked against the
 * session there, never trusted. @see `server/index.ts`
 *
 * **A name is typed once here and never again.** It is the only thing about a
 * character that cannot be changed, which is what makes it worth recognising
 * across a square — see `../lib/characterName`, which is where the rules are
 * and which the field below runs on every keystroke so a refusal arrives while
 * somebody is still typing.
 *
 * Three is the ceiling, and the form goes away rather than being refused at it:
 * a field that is only ever going to say no is a field that should not be on
 * screen.
 *
 * **It is also where the account's own controls live** — Sign out, and Change
 * password. You sign in and out of an *account*; a *character* enters and
 * leaves the world, and the game's menu offers only the second. Keeping the two
 * vocabularies on two screens is what stops them collapsing into one word.
 * @see `docs/notes.md`, "An account signs in; a character enters"
 */
export function CharacterScreen({
  username,
  characters,
  onPlay,
  onMade,
  onSignOut,
  entering,
}: {
  username: string;
  characters: readonly Character[];
  /** Enter the world as this character. */
  onPlay: (character: Character) => void;
  /** A character was just made, so the page can take the new list. */
  onMade: (character: Character) => void;
  onSignOut: () => void;
  /**
   * Whether the world asked for by the last press is on its way.
   *
   * **This screen is the wait as well**, which is why it is told. Opening the
   * socket, waiting on `hello` and waiting for the first frame are three waits,
   * and a screen apiece is a page flickering through states nobody can act on.
   * So the press does not swap the page: the row it was pressed on says what it
   * started, and everything else goes quiet behind it.
   * @see `../routes/game`'s `entering`
   */
  entering: boolean;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Which row was pressed, so the wait is reported on it rather than on the
   * screen. Local because it is only true between a press and this screen going
   * away, and the page above has no use for it.
   */
  const [pressed, setPressed] = useState<string | null>(null);
  const full = characters.length >= MAX_CHARACTERS_PER_ACCOUNT;

  // Run on what has been typed so far, so a digit is refused as it is typed
  // rather than on the press. Not shown for an empty field: somebody who has
  // not typed anything has not got it wrong.
  const typedProblem = name ? characterNameProblem(name) : null;

  const make = async () => {
    setBusy(true);
    setError(null);
    const made = await createCharacter(name);
    setBusy(false);
    if (!made.ok) {
      setError(made.error);
      return;
    }
    setName("");
    onMade(made.value);
  };

  return (
    <Door>
      <DoorTitle>Signed in as {username}</DoorTitle>

      {characters.length > 0 ? (
        <ul className="flex w-full max-w-xs flex-col gap-2">
          {characters.map((character) => (
            <li key={character.id}>
              <DoorButton
                className="w-full"
                disabled={entering}
                onClick={() => {
                  setPressed(character.id);
                  onPlay(character);
                }}
              >
                {entering && pressed === character.id
                  ? "Entering…"
                  : character.name}
              </DoorButton>
            </li>
          ))}
        </ul>
      ) : null}

      {full ? (
        <DoorNote>
          An account holds {MAX_CHARACTERS_PER_ACCOUNT} characters, and this one
          is full.
        </DoorNote>
      ) : (
        <form
          className="flex w-full max-w-xs flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void make();
          }}
        >
          <DoorField
            label="New character"
            autoFocus={characters.length === 0}
            autoCapitalize="words"
            autoCorrect="off"
            spellCheck={false}
            // Nothing the browser has stored is a character name, and offering
            // somebody their own email address here would be a suggestion they
            // cannot use.
            autoComplete="off"
            // The server normalises and refuses again — this only stops the
            // field growing past what could ever be accepted.
            maxLength={MAX_CHARACTER_NAME_LENGTH}
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
          <DoorButton
            type="submit"
            disabled={busy || entering || !name || typedProblem !== null}
          >
            {busy ? "Just a moment…" : "Create character"}
          </DoorButton>
        </form>
      )}

      {/* One line under the field, not two. The standing rule and the reason
          this particular name is refused say almost the same thing, so the
          refusal takes the rule's place rather than stacking under it — two
          sentences about letters is a screen that reads as shouting. */}
      {full ? null : typedProblem ? (
        <DoorNote>{typedProblem}</DoorNote>
      ) : (
        <DoorNote>
          Letters only, up to {MAX_CHARACTER_NAME_LENGTH}. A name is chosen once
          and cannot be changed.
        </DoorNote>
      )}
      {error ? <DoorError>{error}</DoorError> : null}

      {/* The account's own two controls, and the only two anywhere. Signing in
          and out is what you do with an account; entering and leaving the world
          is what a character does — so the game's own menu offers neither of
          these. @see ./ChangePassword

          `max-w-xs` to match the fields above: the password form expands in
          place here, and one that came out narrower than the field it appeared
          under would read as a different screen arriving. */}
      <div className="flex w-full max-w-xs flex-col items-center gap-3">
        <ChangePassword disabled={entering} />
        <button
          type="button"
          className="text-xs uppercase tracking-widest text-paper/50 underline underline-offset-4 hover:text-paper disabled:opacity-50"
          style={{ fontFamily: SYSTEM_MONO }}
          disabled={entering}
          onClick={onSignOut}
        >
          Sign out
        </button>
      </div>
    </Door>
  );
}
