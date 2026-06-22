import Mustache from "mustache";
import type { StepContext } from "../loops/runner.js";

export function resolveTemplate(template: string, context: StepContext): string {
  // Pre-pass: replace {{steps.ID.output}} patterns before Mustache processes them
  // Mustache can't handle dynamic keys, so we substitute these manually first
  const preProcessed = template.replace(
    /\{\{steps\.([^}]+)\.output\}\}/g,
    (_match, stepId: string) => {
      return context.stepOutputs[stepId] ?? "";
    }
  );

  const alwaysContent = context.memories.always
    .map((m) => m.content)
    .join("\n\n---\n\n");

  const semanticContent = context.memories.semantic
    .map((m) => m.content)
    .join("\n\n---\n\n");

  const globalContent = context.memories.all
    .filter((m) => m.tier === "global")
    .map((m) => m.content)
    .join("\n\n---\n\n");

  const projectContent = context.memories.all
    .filter((m) => m.tier === "project")
    .map((m) => m.content)
    .join("\n\n---\n\n");

  const sessionContext =
    (context.conversationHistory ?? [])
      .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
      .join("\n\n") || "(no prior conversation)";

  const view = {
    memory: {
      always: alwaysContent,
      semantic: semanticContent,
      global: globalContent,
      project: projectContent,
    },
    context: context.context,
    session_context: sessionContext,
  };

  return Mustache.render(preProcessed, view);
}
