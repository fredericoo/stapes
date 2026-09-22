import { Link, redirect, useNavigate } from "react-router";
import { Door, DoorLogo, DoorNote, DoorTitle, SYSTEM_MONO } from "../components/door";
import { SignInForm } from "../components/SignInForm";
import { fetchMe } from "../lib/auth";

/**
 * The front door: sign in to an account.
 *
 * Signing in is not a wait in the way entering the world is — it ends in
 * another question rather than in a world — so this screen simply goes and the
 * chooser takes its place.
 *
 * A browser that already has a session is sent straight on. Otherwise
 * `/sign-in` would be a screen somebody could sit at while signed in, with a
 * form that logs them in as themselves.
 */
export async function clientLoader() {
  const me = await fetchMe();
  if (me.user) throw redirect("/characters");
  return null;
}

export default function SignInPage() {
  const navigate = useNavigate();

  return (
    <Door>
      <DoorLogo />
      <DoorTitle>Sign in</DoorTitle>
      <SignInForm onSignedIn={() => void navigate("/characters")} />
      <DoorNote>
        <Link
          to="/sign-up"
          className="uppercase tracking-widest underline underline-offset-4 hover:text-paper"
          style={{ fontFamily: SYSTEM_MONO }}
        >
          Create an account
        </Link>
      </DoorNote>
    </Door>
  );
}
