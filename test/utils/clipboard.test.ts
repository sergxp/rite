import { beforeEach, describe, expect, it, vi } from "vitest"

const execaMock = vi.fn().mockResolvedValue({})

vi.mock("execa", () => ({
  execa: execaMock,
}))

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value: platform })
  try {
    return await fn()
  } finally {
    if (original) Object.defineProperty(process, "platform", original)
  }
}

describe("copyToClipboard", () => {
  beforeEach(() => {
    execaMock.mockClear()
    delete process.env.RITE_FAKE_CLIPBOARD
    vi.resetModules()
  })

  it("uses Unicode-safe PowerShell clipboard writes on Windows", async () => {
    await withPlatform("win32", async () => {
      const { copyToClipboard } = await import("../../src/utils/clipboard")
      const ok = await copyToClipboard("**NTM Qty** = `max(0, 4 − 6)` • $0")

      expect(ok).toBe(true)
      expect(execaMock).toHaveBeenCalledWith(
        "powershell.exe",
        expect.arrayContaining(["-NoProfile", "-NonInteractive"]),
        { input: "**NTM Qty** = `max(0, 4 − 6)` • $0" },
      )
      expect(execaMock.mock.calls[0][1].join(" ")).toContain("InputEncoding")
      expect(execaMock.mock.calls[0][1].join(" ")).toContain("Set-Clipboard")
    })
  })

  it("does not use clip.exe on Windows because it mojibakes UTF-8 markdown", async () => {
    await withPlatform("win32", async () => {
      const { copyToClipboard } = await import("../../src/utils/clipboard")
      await copyToClipboard("— × •")

      expect(execaMock.mock.calls[0][0]).not.toBe("clip")
    })
  })
})
