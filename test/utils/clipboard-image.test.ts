import { describe, expect, it } from "vitest"
import { nextAttachmentImagePath } from "../../src/utils/clipboard-image"

describe("nextAttachmentImagePath", () => {
  it("stores pasted clipboard images under attachments/images", () => {
    const path = nextAttachmentImagePath("session-123")

    expect(path).toContain(".rite")
    expect(path).toContain("attachments")
    expect(path).toContain("images")
    expect(path).toContain("session-123")
    expect(path).toMatch(/\.png$/)
    expect(path).not.toContain("pastes")
  })
})
