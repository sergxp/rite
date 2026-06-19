import { describe, expect, it } from "vitest"
import type { Renderable } from "@opentui/core"
import type { Selection } from "@opentui/core/lib/selection"
import {
  markdownCopyTextForSelection,
  registerMarkdownCopySource,
  unregisterMarkdownCopySource,
} from "../../src/utils/markdown-copy-source"

function renderable(id: string, parent: Renderable | null = null): Renderable {
  return {
    id,
    parent,
    isDestroyed: false,
  } as Renderable
}

function selection(selectedRenderables: Renderable[]): Selection {
  return {
    selectedRenderables,
    getSelectedText: () => "rendered text",
  } as Selection
}

describe("markdown copy source registry", () => {
  it("returns registered markdown source for selected markdown descendants", () => {
    const markdown = renderable("assistant-md-1")
    const child = renderable("markdown-text-child", markdown)
    registerMarkdownCopySource("assistant-md-1", "**bold** and `code`")

    expect(markdownCopyTextForSelection(selection([child]))).toBe("**bold** and `code`")

    unregisterMarkdownCopySource("assistant-md-1")
  })

  it("deduplicates multiple selected descendants from the same markdown block", () => {
    const markdown = renderable("assistant-md-2")
    const childA = renderable("markdown-child-a", markdown)
    const childB = renderable("markdown-child-b", markdown)
    registerMarkdownCopySource("assistant-md-2", "- item")

    expect(markdownCopyTextForSelection(selection([childA, childB]))).toBe("- item")

    unregisterMarkdownCopySource("assistant-md-2")
  })

  it("falls back when no selected renderable has a registered source", () => {
    expect(markdownCopyTextForSelection(selection([renderable("plain")]))).toBeNull()
  })
})
