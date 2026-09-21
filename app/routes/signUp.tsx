import { useState } from "react";
import { Link, redirect, useNavigate } from "react-router";
import {
  Door,
  DoorButton,
  DoorError,
  DoorField,
  DoorNote,
  DoorTitle,
  SYSTEM_MONO,
} from "../components/door";
import { MIN_PASSWORD_LENGTH } from "../lib/account";
import { fetchMe, signUp } from "../lib/auth";

/**
 * Make an account: a username, an email and a password.
 *
 * **The email is asked for once, here, and then only stored.** Nothing sends to
 * it, nothing verifies it, and there is no reset behind it — which is why the
 * note under the form says a forgotten password is a lost account before
 * anybody has typed one. What the address buys is a way to reach somebody about
 * their account at all, which a game with no other contact detail had none of.
 * @see `server/auth.ts`
 *
 * It signs you in as it creates you, so what follows is the chooser rather than
 * the door you just came through.
 */
export async function clientLoader() {
  const me = await fetchMe();
  if (me.user) throw redirect("/characters");
  return null;
}

export default function SignUpPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const attempt = await signUp(username, email, password);
    setBusy(false);
    if (!attempt.ok) {
      setError(attempt.error);
      return;
    }
    void navigate("/characters");
  };

  return (
    <Door>
      <DoorTitle>New account</DoorTitle>
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
          label="Email"
          type="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="email"
          value={email}
          disabled={busy}
          onChange={(event) => setEmail(event.target.value)}
        />
        <DoorField
          label="Password"
          type="password"
          autoComplete="new-password"
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
        <DoorButton
          type="submit"
          disabled={busy || !username || !email || !password}
          className="mt-1"
        >
          {busy ? "Just a moment…" : "Create account"}
        </DoorButton>
      </form>
      {error ? <DoorError>{error}</DoorError> : null}
      <DoorNote>
        At least {MIN_PASSWORD_LENGTH} characters. There is no password reset, so pick one you will
        remember.
      </DoorNote>
      <DoorNote>
        <Link
          to="/sign-in"
          className="uppercase tracking-widest underline underline-offset-4 hover:text-paper"
          style={{ fontFamily: SYSTEM_MONO }}
        >
          I already have an account
        </Link>
      </DoorNote>
    </Door>
  );
}
