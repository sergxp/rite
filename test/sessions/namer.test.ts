import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/backends/utility.js", () => ({
  callUtilityBlocking: vi.fn(),
}))

import { callUtilityBlocking } from "../../src/backends/utility.js"
import { SessionStore } from "../../src/sessions/store.js"
import { autoNameForkSession } from "../../src/sessions/namer.js"

const mockUtil = callUtilityBlocking as unknown as ReturnType<typeof vi.fn>

describe("autoNameForkSession", () => {
  beforeEach(() => {
    mockUtil.mockReset()
    vi.restoreAllMocks()
  })

  it("uses recent turns to rename the fork", async () => {
    mockUtil.mockResolvedValue('"Investigate Sidebar Clicks."')
    const renameSpy = vi.spyOn(SessionStore, "rename").mockResolvedValue(null)
    const onNamed = vi.fn()

    await autoNameForkSession(
      "fork-1",
      [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
        { role: "assistant", content: "fourth" },
        { role: "user", content: "fifth" },
      ],
      {} as never,
      onNamed,
    )

    expect(mockUtil).toHaveBeenCalledTimes(1)
    const prompt = mockUtil.mock.calls[0]?.[0] as string
    expect(prompt).toContain("forked branch")
    expect(prompt).not.toContain(">first<")
    expect(prompt).toContain("second")
    expect(prompt).toContain("fifth")
    expect(renameSpy).toHaveBeenCalledWith("fork-1", "Investigate Sidebar Clicks", process.cwd())
    expect(onNamed).toHaveBeenCalledWith("Investigate Sidebar Clicks")
  })

  it("does nothing when there are no turns", async () => {
    const renameSpy = vi.spyOn(SessionStore, "rename").mockResolvedValue(null)

    await autoNameForkSession("fork-1", [], {} as never)

    expect(mockUtil).not.toHaveBeenCalled()
    expect(renameSpy).not.toHaveBeenCalled()
  })
})
