/**
 * What an account's credentials have to look like.
 *
 * Shared by both halves for the reason `./characterName` is: the server
 * enforces these and the sign-in form quotes them, and a form that says
 * "at least 8" in front of a server that wants 10 is a form that lies.
 *
 * A username is not a character name and the rules are deliberately looser —
 * nothing draws it over anybody's head, so it can hold digits and underscores
 * without making a square full of people unreadable. @see ./characterName
 */

export const MIN_USERNAME_LENGTH = 3;
export const MAX_USERNAME_LENGTH = 30;

/**
 * The password floor.
 *
 * **Deliberately not a policy.** There is no email on an account here and no
 * recovery, so a forgotten password is a lost account and every rule beyond a
 * length is a rule that makes people write theirs down. Eight characters is
 * the floor Better Auth defaults to, stated here so the form can say it before
 * anybody is refused for missing it.
 */
export const MIN_PASSWORD_LENGTH = 8;
