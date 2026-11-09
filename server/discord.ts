const POST_TIMEOUT_MS = 10_000;

const DESCRIPTION_LIMIT = 4096;

export type Announcement = {
  title: string;
  lines: string[];
  tone: "alert" | "resolved" | "test";
  link?: string;
};

export type Announce = (announcement: Announcement) => Promise<void>;

const COLORS: Record<Announcement["tone"], number> = {
  alert: 0x9b2226,
  resolved: 0x2d6a4f,
  test: 0x7a7568,
};

/** A failed post is logged and not thrown: the caller is a timer, and an alert that cannot be delivered must not stop the next one. */
export function discordAnnouncer(webhookUrl: string): Announce {
  return async ({ title, lines, tone, link }) => {
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          embeds: [
            {
              title,
              description: lines.join("\n").slice(0, DESCRIPTION_LIMIT),
              color: COLORS[tone],
              ...(link ? { url: link } : {}),
            },
          ],
        }),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      if (!response.ok) console.error(`[alerts] Discord answered ${response.status}`);
    } catch (error) {
      console.error("[alerts] Discord post failed", error);
    }
  };
}

export const logAnnouncer: Announce = async ({ title, lines }) => {
  console.warn(`[alerts] ${title}\n${lines.join("\n")}`);
};
