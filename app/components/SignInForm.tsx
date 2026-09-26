import { useState } from "react";
import { DoorButton, DoorError, DoorField } from "./door";
import { signIn } from "../lib/auth";

export function SignInForm({
  onSignedIn,
  submitLabel = "Sign in",
}: {
  onSignedIn: () => void;
  submitLabel?: string;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const attempt = await signIn(username, password);
    setBusy(false);
    if (!attempt.ok) {
      setError(attempt.error);
      return;
    }
    onSignedIn();
  };

  return (
    <>
      <form
        className="flex w-full max-w-xs flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <DoorField
          label="Username"
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="username"
          value={username}
          disabled={busy}
          onChange={(event) => setUsername(event.target.value)}
        />
        <DoorField
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
        <DoorButton type="submit" disabled={busy || !username || !password} className="mt-1">
          {busy ? "Just a moment…" : submitLabel}
        </DoorButton>
      </form>
      {error ? <DoorError>{error}</DoorError> : null}
    </>
  );
}
