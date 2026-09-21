import { useState } from "react";
import { redirect, useNavigate } from "react-router";
import { Door, DoorButton, DoorError, DoorField, DoorNote, DoorTitle } from "../components/door";
import {
  MAX_CHARACTERS_PER_ACCOUNT,
  MAX_CHARACTER_NAME_LENGTH,
  characterNameProblem,
} from "../lib/characterName";
import { createCharacter, fetchMe } from "../lib/auth";
import { rememberCharacter } from "../lib/playing";

/**
 * Name a character, once.
 *
 * **The name is the whole screen**, because it is the one thing about a
 * character that can never be changed — see `../lib/characterName`, which is
 * where the rules are. The field runs them on every keystroke, so `Ka1n` is
 * refused while somebody is still typing rather than on the press; the line
 * underneath swaps from the standing rule to the reason, because two sentences
 * about letters is a screen that reads as shouting.
 *
 * Uniqueness is the one rule the field cannot check. It is a question about the
 * database and only the insert can answer it without a race, so "that name is
 * taken" arrives from the server. @see `server/characters.ts`
 *
 * **Straight into the world on success.** Somebody who has just typed a name
 * has said what they want to do next, and sending them back to a list with one
 * new row on it is asking them to say it twice.
 *
 * A full account is turned away here rather than shown a form that can only
 * refuse it.
 */
export async function clientLoader() {
  const me = await fetchMe();
  if (!me.user) throw redirect("/sign-in");
  if (me.characters.length >= MAX_CHARACTERS_PER_ACCOUNT) {
    throw redirect("/characters");
  }
  return null;
}

export default function NewCharacterPage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Not shown for an empty field: somebody who has not typed anything has not
  // got it wrong.
  const typedProblem = name ? characterNameProblem(name) : null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const made = await createCharacter(name);
    setBusy(false);
    if (!made.ok) {
      setError(made.error);
      return;
    }
    rememberCharacter(made.value);
    void navigate("/");
  };

  return (
    <Door>
      <DoorTitle>New character</DoorTitle>
      <form
        className="flex w-full max-w-xs flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <DoorField
          label="Name"
          autoFocus
          autoCapitalize="words"
          autoCorrect="off"
          spellCheck={false}
          // Nothing the browser has stored is a character name, and offering
          // somebody their own email address here would be a suggestion they
          // cannot use.
          autoComplete="off"
          // The server normalises and refuses again — this only stops the field
          // growing past what could ever be accepted.
          maxLength={MAX_CHARACTER_NAME_LENGTH}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
        <DoorButton type="submit" disabled={busy || !name || typedProblem !== null}>
          {busy ? "Just a moment…" : "Create and enter"}
        </DoorButton>
      </form>

      {/* One line under the field, not two: the refusal takes the rule's place
          rather than stacking under it. */}
      {typedProblem ? (
        <DoorNote>{typedProblem}</DoorNote>
      ) : (
        <DoorNote>
          Letters only, up to {MAX_CHARACTER_NAME_LENGTH}. A name is chosen once and cannot be
          changed.
        </DoorNote>
      )}
      {error ? <DoorError>{error}</DoorError> : null}

      <BackLink busy={busy} onBack={() => void navigate("/characters")} />
    </Door>
  );
}

function BackLink({ busy, onBack }: { busy: boolean; onBack: () => void }) {
  return (
    <button
      type="button"
      className="text-xs uppercase tracking-widest text-paper/50 underline underline-offset-4 hover:text-paper disabled:opacity-50"
      disabled={busy}
      onClick={onBack}
    >
      Back
    </button>
  );
}
