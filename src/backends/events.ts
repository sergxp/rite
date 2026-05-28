export type BackendEvent =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_call"; name: string; id: string }
  | { type: "tool_done"; name: string; id: string };
