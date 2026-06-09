export type BackendEvent =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_call"; name: string; id: string }
  | { type: "tool_done"; name: string; id: string; inputJson: string }
  | { type: "tool_result"; id: string; result: string; isError: boolean }
  | { type: "session_id"; sessionId: string };

export interface ImageAttachment {
  base64: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  label: string;
}
