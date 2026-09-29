export type ToWorld =
  | {
      kind: "open";
      id: number;
      actorId: string;
      protocolVersion: number;
    }
  | { kind: "frame"; id: number; data: string }
  | { kind: "close"; id: number }
  | { kind: "reset" };

export type FromWorld =
  | { kind: "frame"; id: number; data: string }
  | { kind: "closed"; id: number; code: number; reason: string };
