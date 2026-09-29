import { useState } from "react";
import { redirect, useNavigate } from "react-router";
import { CharacterNameField } from "../components/CharacterNameField";
import { Door, DoorButton, DoorError, DoorNote, DoorTitle, SYSTEM_MONO } from "../components/door";
import { MAX_CHARACTER_NAME_LENGTH, characterNameProblem } from "../lib/characterName";
import { fetchMe, startGuest } from "../lib/auth";
import { rememberCharacter } from "../lib/playing";

export async function clientLoader() {
  const me = await fetchMe();
  if (me.user) throw redirect("/characters");
  return null;
}

export default function GuestPage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typedProblem = name ? characterNameProblem(name) : null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const started = await startGuest(name);
    setBusy(false);
    if (!started.ok) {
      setError(started.error);
      return;
    }
    rememberCharacter(started.value);
    void navigate("/online");
  };

  return (
    <Door>
      <DoorTitle>Play as a guest</DoorTitle>
      <form
        className="flex w-full max-w-xs flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <CharacterNameField value={name} disabled={busy} onChange={setName} />
        <DoorButton type="submit" disabled={busy || !name || typedProblem !== null}>
          {busy ? "Just a moment…" : "Play"}
        </DoorButton>
      </form>

      {typedProblem ? (
        <DoorNote>{typedProblem}</DoorNote>
      ) : (
        <DoorNote>
          Letters and spaces, up to {MAX_CHARACTER_NAME_LENGTH}. To keep this character, save it to
          an account from the menu while you play.
        </DoorNote>
      )}
      {error ? <DoorError>{error}</DoorError> : null}

      <button
        type="button"
        className="text-xs uppercase tracking-widest text-paper/50 underline underline-offset-4 hover:text-paper disabled:opacity-50"
        style={{ fontFamily: SYSTEM_MONO }}
        disabled={busy}
        onClick={() => void navigate("/sign-in")}
      >
        I have an account
      </button>
    </Door>
  );
}
