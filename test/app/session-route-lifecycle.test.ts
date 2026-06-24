import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("session route lifecycle", () => {
  it("does not key-remount the native session tree on fork/session switches", () => {
    const appSource = readFileSync(new URL("../../src/app.tsx", import.meta.url), "utf8")
    const sessionSource = readFileSync(new URL("../../src/routes/session/index.tsx", import.meta.url), "utf8")
    const sessionRoute = appSource.slice(appSource.indexOf("<Match when={route.data().type === \"session\"}>"))

    expect(sessionRoute).toContain("<Session />")
    expect(sessionRoute).not.toContain("keyed")
    expect(sessionSource).not.toContain("<Show when={session()} keyed")
  })

  it("reserves dynamic footer height for wrapped footer labels", () => {
    const sessionSource = readFileSync(new URL("../../src/routes/session/index.tsx", import.meta.url), "utf8")

    expect(sessionSource).toContain("const [footerHeight, setFooterHeight] = createSignal(1)")
    expect(sessionSource).toContain("dimensions().height - composerHeight() - footerHeight()")
    expect(sessionSource).toContain("onHeightChange={setFooterHeight}")
    expect(sessionSource).not.toContain("FOOTER_HEIGHT")
  })
})
