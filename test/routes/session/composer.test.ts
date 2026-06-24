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

describe("session composer loop context handoff", () => {
  const source = () => readFileSync(new URL("../../../src/routes/session/composer.tsx", import.meta.url), "utf8")

  it("records loop turns into live conversation history for the regular agent", () => {
    const text = source()

    expect(text).toContain("formatLoopHistoryAnswer")
    expect(text).toContain('history.add("user", userText)')
    expect(text).toContain('history.add("assistant", assistantContent)')
    expect(text).toContain("recordLoopTurn(props.session, props.history, loop.name")
    expect(text).toContain("recordLoopTurn(s, props.history, loop.name")
  })

  it("settles loop transcript and footer status when loops finish", () => {
    const text = source()

    expect(text).toContain("function settleLoopDisplayItems")
    expect(text).toContain("store.setItems(sid, settled)")
    expect(text).toContain('item.kind === "assistant" || item.kind === "thinking"')
    expect(text).toContain('item.kind === "tool"')
    expect(text).toContain("props.onStatus(\"\")")
    expect(text).toContain("props.session.displayItems = settledItems")
    expect(text).toContain("s.displayItems = settledItems")
  })

  it("persists loop display items after attaching them to the session", () => {
    const text = source()
    const recordLoopTurnBody = text.slice(text.indexOf("function recordLoopTurn"), text.indexOf("function completionsFor"))
    const slashDisplayItems = text.indexOf("props.session.displayItems = settledItems")
    const slashSave = text.indexOf("await SessionStore.save(props.session)", slashDisplayItems)
    const activeDisplayItems = text.indexOf("s.displayItems = settledItems")
    const activeSave = text.indexOf("await SessionStore.save(s)", activeDisplayItems)

    expect(recordLoopTurnBody).not.toContain("SessionStore.save")
    expect(slashDisplayItems).toBeGreaterThan(-1)
    expect(slashSave).toBeGreaterThan(slashDisplayItems)
    expect(activeDisplayItems).toBeGreaterThan(-1)
    expect(activeSave).toBeGreaterThan(activeDisplayItems)
  })
})
