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
          autoComplete="off"
          maxLength={MAX_CHARACTER_NAME_LENGTH}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
        <DoorButton type="submit" disabled={busy || !name || typedProblem !== null}>
          {busy ? "Just a moment…" : "Create and enter"}
        </DoorButton>
      </form>

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
