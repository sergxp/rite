import type { Renderable } from "@opentui/core"
import type { Selection } from "@opentui/core/lib/selection"

const markdownSources = new Map<string, string>()

export function registerMarkdownCopySource(id: string, source: string) {
  markdownSources.set(id, source)
}

export function unregisterMarkdownCopySource(id: string) {
  markdownSources.delete(id)
}

function sourceIdForRenderable(renderable: Renderable): string | null {
  let current: Renderable | null = renderable
  while (current) {
    if (markdownSources.has(current.id)) return current.id
    current = current.parent
  }
  return null
}

export function markdownCopyTextForSelection(selection: Selection): string | null {
  const ids: string[] = []
  const seen = new Set<string>()

  for (const renderable of selection.selectedRenderables ?? []) {
    if (renderable.isDestroyed) continue
    const id = sourceIdForRenderable(renderable)
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }

  if (ids.length === 0) return null
  return ids.map((id) => markdownSources.get(id)).filter((text): text is string => typeof text === "string").join("\n\n")
}
