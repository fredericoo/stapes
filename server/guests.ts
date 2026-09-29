import { characterNameProblem, normaliseCharacterName } from "../app/lib/characterName";
import type { Auth, Viewer } from "./auth";
import type { Character, Characters } from "./characters";

export type Refused = { error: string };

export type Claim = { username: string; email: string; password: string };

const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+$/;

export async function startGuest(
  auth: Auth,
  characters: Characters,
  typed: string,
): Promise<{ character: Character; headers: Headers } | Refused> {
  const problem = characterNameProblem(typed);
  if (problem) return { error: problem };
  if (await characters.nameTaken(typed)) {
    return { error: `${normaliseCharacterName(typed)} is already taken.` };
  }

  const signedIn = await auth.api.signInAnonymous({ returnHeaders: true });
  const userId = signedIn.response.user.id;
  const made = await characters.create(userId, typed);
  if ("error" in made) {
    const context = await auth.$context;
    await context.internalAdapter.deleteUser(userId);
    return made;
  }
  return { character: made.character, headers: signedIn.headers };
}

/**
 * Turns the guest into an ordinary account in place, so its id, its character
 * and the session it is playing on all stay as they are. The credential is
 * written before the user row, so a claim that fails on the second write leaves
 * a guest that can simply claim again. Better Auth throws for a username it
 * refuses outright, and the caller turns that into a refusal.
 */
export async function claimGuest(
  auth: Auth,
  viewer: Viewer,
  claim: Claim,
): Promise<{ ok: true } | Refused> {
  if (!viewer.guest) return { error: "This account is already saved." };

  const username = claim.username.trim();
  const { available } = await auth.api.isUsernameAvailable({ body: { username } });
  if (!available) return { error: "That username is taken." };

  const email = claim.email.trim().toLowerCase();
  if (!LOOKS_LIKE_EMAIL.test(email)) return { error: "Enter an email address." };

  const context = await auth.$context;
  if (await context.internalAdapter.findUserByEmail(email)) {
    return { error: "That email already has an account." };
  }

  const { minPasswordLength, maxPasswordLength } = context.password.config;
  if (claim.password.length < minPasswordLength) {
    return { error: `Use at least ${minPasswordLength} characters for the password.` };
  }
  if (claim.password.length > maxPasswordLength) {
    return { error: `Use at most ${maxPasswordLength} characters for the password.` };
  }

  const password = await context.password.hash(claim.password);
  const credential = await context.internalAdapter.findCredentialAccount(viewer.id);
  if (credential) {
    await context.internalAdapter.updateAccount(credential.id, { password });
  } else {
    await context.internalAdapter.linkAccount({
      userId: viewer.id,
      providerId: "credential",
      accountId: viewer.id,
      password,
    });
  }

  try {
    await context.internalAdapter.updateUser(viewer.id, {
      username: username.toLowerCase(),
      name: username,
      email,
      isAnonymous: false,
    });
  } catch {
    return { error: "That username or email was just taken. Try another." };
  }
  return { ok: true };
}
