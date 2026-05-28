export type BackendEvent =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_call"; name: string; id: string }
  | { type: "tool_done"; name: string; id: string; inputJson: string }
  | { type: "tool_result"; id: string; result: string; isError: boolean };
