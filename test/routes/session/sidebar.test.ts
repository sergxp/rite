import { describe, expect, it } from "vitest"
import { MAX_SIDEBAR_FORK_ROWS, visibleForksForSidebar } from "../../../src/routes/session"

function fork(id: string, createdAt: string) {
  return { id, createdAt }
}

describe("visibleForksForSidebar", () => {
  it("keeps small fork groups intact", () => {
    const forks = [fork("a", "2025-01-01T00:00:00.000Z"), fork("b", "2025-01-02T00:00:00.000Z")]

    expect(visibleForksForSidebar(forks, "a")).toEqual(forks)
  })

  it("caps large fork groups to stay below the native selection listener warning threshold", () => {
    const forks = Array.from({ length: 20 }, (_, i) =>
      fork(`fork-${i}`, `2025-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`),
    )

    const visible = visibleForksForSidebar(forks, "fork-10")

    expect(visible).toHaveLength(MAX_SIDEBAR_FORK_ROWS)
    expect(visible.map((f) => f.id)).toContain("fork-10")
  })

  it("shows the newest forks when the current fork is not loaded into the list yet", () => {
    const forks = Array.from({ length: 10 }, (_, i) =>
      fork(`fork-${i}`, `2025-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`),
    )

    const visible = visibleForksForSidebar(forks, "missing")

    expect(visible).toHaveLength(MAX_SIDEBAR_FORK_ROWS)
    expect(visible.at(-1)?.id).toBe("fork-9")
  })
})
