export type BackendEvent =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_call"; name: string; id: string }
  | { type: "tool_done"; name: string; id: string; inputJson: string }
  | { type: "tool_result"; id: string; result: string; isError: boolean }
  | { type: "session_id"; sessionId: string }

export interface BackendCallOpts {
  resumeSessionId?: string
  model?: string
  /** Effort level passed to the Claude CLI (--effort): "low" | "medium" | "high". */
  effort?: string
  /** Correlation id for this turn — surfaces in logs so a single turn can be traced. */
  turnId?: string
  /** Session id, attached to every log line for this call. */
  sessionId?: string
}

export type BackendFn = (
  prompt: string,
  signal?: AbortSignal,
  opts?: BackendCallOpts,
) => AsyncIterable<BackendEvent>
