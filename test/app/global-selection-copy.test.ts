import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@opentui/solid", async () => {
  const actual = await vi.importActual<typeof import("@opentui/solid")>("@opentui/solid")
  return {
    ...actual,
    useSelectionHandler: vi.fn(),
  }
})

vi.mock("../../src/utils/clipboard", () => ({
  copyToClipboard: vi.fn().mockResolvedValue(true),
}))

import { useSelectionHandler } from "@opentui/solid"
import { copyToClipboard } from "../../src/utils/clipboard"
import { GlobalSelectionCopy } from "../../src/app"
import { registerMarkdownCopySource, unregisterMarkdownCopySource } from "../../src/utils/markdown-copy-source"
import type { Renderable } from "@opentui/core"

const mockSelectionHandler = useSelectionHandler as unknown as ReturnType<typeof vi.fn>
const mockCopy = copyToClipboard as unknown as ReturnType<typeof vi.fn>

describe("GlobalSelectionCopy", () => {
  beforeEach(() => {
    mockSelectionHandler.mockReset()
    mockCopy.mockClear()
  })

  it("registers a single selection handler and copies non-empty selections", async () => {
    let handler: ((selection: { getSelectedText?: () => string } | null) => void) | undefined
    mockSelectionHandler.mockImplementation((fn) => {
      handler = fn
    })

    GlobalSelectionCopy()

    expect(mockSelectionHandler).toHaveBeenCalledTimes(1)
    expect(handler).toBeTypeOf("function")

    handler?.({ getSelectedText: () => "copied text" })
    await Promise.resolve()

    expect(mockCopy).toHaveBeenCalledWith("copied text")
  })

  it("copies registered markdown source instead of rendered selection text", async () => {
    let handler: ((selection: { selectedRenderables?: Renderable[]; getSelectedText?: () => string } | null) => void) | undefined
    mockSelectionHandler.mockImplementation((fn) => {
      handler = fn
    })
    const markdown = { id: "assistant-md-copy", parent: null, isDestroyed: false } as Renderable
    const child = { id: "assistant-md-copy-child", parent: markdown, isDestroyed: false } as Renderable
    registerMarkdownCopySource("assistant-md-copy", "**bold** [link](https://example.com)")

    GlobalSelectionCopy()
    handler?.({
      selectedRenderables: [child],
      getSelectedText: () => "bold link",
    })
    await Promise.resolve()

    expect(mockCopy).toHaveBeenCalledWith("**bold** [link](https://example.com)")
    unregisterMarkdownCopySource("assistant-md-copy")
  })

  it("ignores empty selections", async () => {
    let handler: ((selection: { getSelectedText?: () => string } | null) => void) | undefined
    mockSelectionHandler.mockImplementation((fn) => {
      handler = fn
    })

    GlobalSelectionCopy()
    handler?.({ getSelectedText: () => "   " })
    await Promise.resolve()

    expect(mockCopy).not.toHaveBeenCalled()
  })
})
