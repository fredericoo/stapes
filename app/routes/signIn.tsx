import { Link, redirect, useNavigate } from "react-router";
import { Door, DoorLogo, DoorNote, DoorTitle, SYSTEM_MONO } from "../components/door";
import { SignInForm } from "../components/SignInForm";
import { fetchMe } from "../lib/auth";

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
