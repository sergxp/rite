import { readFileSync } from "fs"
import { describe, expect, it } from "vitest"

describe("session composer image paste", () => {
  const source = () => readFileSync(new URL("../../../src/routes/session/composer.tsx", import.meta.url), "utf8")

  it("uses Alt+V for clipboard image insertion instead of /paste", () => {
    const text = source()

    expect(text).toContain('key.meta && key.name === "v"')
    expect(text).toContain("pasteClipboardImage()")
    expect(text).toContain("Alt+V")
    expect(text).toContain("nextAttachmentImagePath")
    expect(text).not.toContain('"/paste"')
    expect(text).not.toContain("trimmed === \"/paste\"")
  })
})

describe("session composer review draft", () => {
  const source = () => readFileSync(new URL("../../../src/routes/session/composer.tsx", import.meta.url), "utf8")

  it("runs review in the background and leaves follow-up control to the user", () => {
    const text = source()

    expect(text).toContain("runComplianceReviewDraft")
    expect(text).toContain("void runComplianceReviewDraft")
    expect(text).toContain("setReviewDraft")
    expect(text).toContain("[ Alt+S Send ]")
    expect(text).toContain("[ Alt+E Edit ]")
    expect(text).toContain("[ Alt+D Dismiss ]")
    expect(text).toContain("No message was sent to the agent.")
    expect(text).not.toContain("await runComplianceReview")
    expect(text).not.toContain("Provide the corrected response only.")
    expect(text).not.toContain("✻ correcting")
  })
})
