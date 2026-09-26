export const NOTICE_LIFETIME_MS = 4_000;

export const MAX_NOTICES = 2;

export type Notice = {
  id: string;
  text: string;
  shownAtMs: number;
};

export class NoticeQueue {
  private notices: Notice[] = [];
  private nextId = 0;

  push(text: string, nowMs: number) {
    this.prune(nowMs);

    const newest = this.notices.at(-1);
    if (newest && newest.text === text) {
      newest.shownAtMs = nowMs;
      return;
    }

    this.notices.push({ id: `notice-${this.nextId++}`, text, shownAtMs: nowMs });
    if (this.notices.length > MAX_NOTICES) {
      this.notices.splice(0, this.notices.length - MAX_NOTICES);
    }
  }

  live(nowMs: number): Notice[] {
    this.prune(nowMs);
    return this.notices;
  }

  private prune(nowMs: number) {
    let expired = 0;
    while (
      expired < this.notices.length &&
      nowMs - this.notices[expired].shownAtMs >= NOTICE_LIFETIME_MS
    ) {
      expired++;
    }
    if (expired > 0) this.notices.splice(0, expired);
  }
}

export class NotificationLayer {
  private readonly stack: HTMLDivElement;
  private readonly entries = new Map<string, HTMLDivElement>();

  constructor(container: HTMLElement) {
    this.stack = document.createElement("div");
    this.stack.className = "notice-stack";
    container.appendChild(this.stack);
  }

  set(notices: Notice[]) {
    const live = new Set<string>();

    for (const notice of notices) {
      live.add(notice.id);
      if (this.entries.has(notice.id)) continue;
      const element = document.createElement("div");
      element.className = "notice";
      element.textContent = notice.text;
      this.stack.appendChild(element);
      this.entries.set(notice.id, element);
    }

    for (const [id, element] of this.entries) {
      if (live.has(id)) continue;
      element.remove();
      this.entries.delete(id);
    }
  }

  dispose() {
    this.stack.remove();
    this.entries.clear();
  }
}
