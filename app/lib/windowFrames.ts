export const WINDOW_FRAMES = ["stone", "timber", "leather", "burlap", "chest"] as const;

export type WindowFrame = (typeof WINDOW_FRAMES)[number];

export const WINDOW_FRAME_LABELS: Record<WindowFrame, string> = {
  stone: "Stone",
  timber: "Timber",
  leather: "Leather",
  burlap: "Burlap",
  chest: "Iron-bound chest",
};
