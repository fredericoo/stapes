const FIRE_TIMEOUT_MS = 15_000;

const API_VERSION = "2026-10-21";

/** The endpoint refuses more than 65,536 characters of text. */
export const ROUTINE_TEXT_LIMIT = 60_000;

export type Routine = { fireUrl: string; token: string };

/**
 * Starts a Claude Code session from a saved routine and resolves to its URL, or
 * to null when it could not be started. It is never retried: the endpoint has
 * no idempotency key, so a retry after a lost response starts a second session.
 */
export async function fireRoutine(routine: Routine, text: string): Promise<string | null> {
  try {
    const response = await fetch(routine.fireUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${routine.token}`,
        "anthropic-version": API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: text.slice(0, ROUTINE_TEXT_LIMIT) }),
      signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(`[alerts] the routine answered ${response.status}`);
      return null;
    }
    const body = (await response.json()) as { claude_code_session_url?: unknown };
    return typeof body.claude_code_session_url === "string" ? body.claude_code_session_url : null;
  } catch (error) {
    console.error("[alerts] firing the routine failed", error);
    return null;
  }
}
