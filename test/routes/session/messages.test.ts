import { describe, expect, it } from "vitest"
import { MAX_RENDERED_TRANSCRIPT_ITEMS, visibleItemsForRender } from "../../../src/routes/session/messages"
import type { DisplayItem } from "../../../src/context/session-store"

describe("visibleItemsForRender", () => {
  it("keeps small transcripts intact", () => {
    const items: DisplayItem[] = [
      { kind: "user", content: "hello" },
      { kind: "assistant", content: "hi" },
    ]

    expect(visibleItemsForRender(items)).toEqual(items)
  })

  it("caps large loaded transcripts to avoid native TextBuffer exhaustion", () => {
    const items: DisplayItem[] = Array.from({ length: 300 }, (_, i) => ({
      kind: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`,
    } as DisplayItem))

    const visible = visibleItemsForRender(items)

    expect(visible).toHaveLength(MAX_RENDERED_TRANSCRIPT_ITEMS)
    expect(visible[0]).toMatchObject({
      kind: "system",
      content: expect.stringContaining("Earlier transcript omitted"),
    })
    expect(visible[1]).toEqual(items[299])
    expect(visible.at(-1)).toEqual(items[299])
  })

  it("keeps at least the omission marker and latest item for tiny viewports", () => {
    const items: DisplayItem[] = Array.from({ length: 300 }, (_, i) => ({
      kind: "user",
      content: `turn ${i}`,
    }))

    const visible = visibleItemsForRender(items, 1)

    expect(visible).toHaveLength(2)
    expect(visible[1]).toEqual(items[299])
    expect(visible.at(-1)).toEqual(items[299])
  })
})
