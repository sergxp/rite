import { describe, expect, it } from "vitest"
import { readFileSync } from "fs"
import { TRANSCRIPT_WINDOW_SIZE, TRANSCRIPT_LOAD_MORE_STEP, prepareMarkdown, renderMarkdownLines } from "../../../src/routes/session/messages"
import type { DisplayItem } from "../../../src/context/session-store"

// Replicate the window-slice logic from the Messages component so we can
// test the windowing behaviour without spinning up a full Solid render.
function windowItems(
  items: DisplayItem[],
  windowStart: number,
): { visible: DisplayItem[]; hiddenCount: number } {
  return { visible: items.slice(windowStart), hiddenCount: windowStart }
}

function naturalStart(itemCount: number): number {
  return Math.max(0, itemCount - TRANSCRIPT_WINDOW_SIZE)
}

describe("transcript windowing", () => {
  it("shows all items when transcript is within the window size", () => {
    const items: DisplayItem[] = Array.from({ length: 10 }, (_, i) => ({
      kind: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`,
    } as DisplayItem))

    const start = naturalStart(items.length)
    const { visible, hiddenCount } = windowItems(items, start)

    expect(hiddenCount).toBe(0)
    expect(visible).toHaveLength(items.length)
    expect(visible).toEqual(items)
  })

  it("windows long transcripts to the tail on initial load", () => {
    const items: DisplayItem[] = Array.from({ length: 200 }, (_, i) => ({
      kind: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`,
    } as DisplayItem))

    const start = naturalStart(items.length)
    const { visible, hiddenCount } = windowItems(items, start)

    expect(hiddenCount).toBe(200 - TRANSCRIPT_WINDOW_SIZE)
    expect(visible).toHaveLength(TRANSCRIPT_WINDOW_SIZE)
    expect(visible.at(-1)).toEqual(items[199])
    expect(visible[0]).toEqual(items[hiddenCount])
  })

  it("Ctrl+U extends window backward by TRANSCRIPT_LOAD_MORE_STEP", () => {
    const items: DisplayItem[] = Array.from({ length: 200 }, (_, i) => ({
      kind: "user",
      content: `turn ${i}`,
    } as DisplayItem))

    const start = naturalStart(items.length)

    // Simulate one Ctrl+U press
    const afterOne = Math.max(0, start - TRANSCRIPT_LOAD_MORE_STEP)
    const { visible: v1, hiddenCount: h1 } = windowItems(items, afterOne)
    expect(h1).toBe(afterOne)
    expect(v1).toHaveLength(200 - afterOne)

    // Simulate a second Ctrl+U press
    const afterTwo = Math.max(0, afterOne - TRANSCRIPT_LOAD_MORE_STEP)
    const { visible: v2, hiddenCount: h2 } = windowItems(items, afterTwo)
    expect(h2).toBe(afterTwo)
    expect(v2).toHaveLength(200 - afterTwo)
  })

  it("Ctrl+U cannot go below index 0", () => {
    const items: DisplayItem[] = Array.from({ length: 5 }, (_, i) => ({
      kind: "user",
      content: `turn ${i}`,
    } as DisplayItem))

    const start = naturalStart(items.length)
    const afterU = Math.max(0, start - TRANSCRIPT_LOAD_MORE_STEP)

    expect(afterU).toBe(0)
    const { visible, hiddenCount } = windowItems(items, afterU)
    expect(hiddenCount).toBe(0)
    expect(visible).toHaveLength(5)
  })

  it("TRANSCRIPT_WINDOW_SIZE and TRANSCRIPT_LOAD_MORE_STEP are reasonable values", () => {
    expect(TRANSCRIPT_WINDOW_SIZE).toBeGreaterThanOrEqual(30)
    expect(TRANSCRIPT_WINDOW_SIZE).toBeLessThanOrEqual(200)
    expect(TRANSCRIPT_LOAD_MORE_STEP).toBeGreaterThan(0)
    expect(TRANSCRIPT_LOAD_MORE_STEP).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_SIZE)
  })
})

describe("assistant markdown preparation", () => {
  it("wraps prose on word boundaries before markdown rendering", () => {
    const md = prepareMarkdown("So the map is showing the amber banner and rendering only inventory.", 29)

    expect(md).toBe([
      "So the map is showing the",
      "amber banner and rendering",
      "only inventory.",
    ].join("\n"))
    expect(md).not.toContain("am\nber")
  })

  it("does not reflow fenced blocks", () => {
    const md = prepareMarkdown([
      "Before the block should wrap cleanly before amber.",
      "```text",
      "this code line intentionally stays longer than the wrapping width",
      "```",
    ].join("\n"), 25)

    expect(md).toContain("Before the block should\nwrap cleanly before\namber.")
    expect(md).toContain("this code line intentionally stays longer than the wrapping width")
  })

  it("renders bold markers as styled text instead of literal asterisks", () => {
    const lines = renderMarkdownLines("**What's happening:** `AutoSendWorkOrderEmails` is iterating orders.", 44)
    const first = lines[0]

    expect(first.kind).toBe("text")
    expect(first.segments?.map((s) => s.text).join("")).toContain("What's happening:")
    expect(first.segments?.map((s) => s.text).join("")).not.toContain("**")
    expect(first.segments?.find((s) => s.text === "What's")?.bold).toBe(true)
    expect(first.segments?.find((s) => s.text === "happening:")?.bold).toBe(true)
  })

  it("does not split normal words after inline markdown is styled", () => {
    const text = "**What's happening:** `AutoSendWorkOrderEmails` is iterating orders and calling `SendWorkOrderEmail` on each."
    const rendered = renderMarkdownLines(text, 45)
      .map((line) => line.segments?.map((s) => s.text).join("") ?? line.text ?? "")
      .join("\n")

    expect(rendered).toContain("iterating")
    expect(rendered).not.toContain("iter\nating")
  })

  it("uses native strong nodes for visible bold rendering", () => {
    const source = readFileSync(new URL("../../../src/routes/session/messages.tsx", import.meta.url), "utf8")
    const inlineSegmentView = source.slice(source.indexOf("function InlineSegmentView"), source.indexOf("function ItemView"))

    expect(inlineSegmentView).toContain("<strong>")
    expect(inlineSegmentView).not.toContain("bold: true")
  })
})
