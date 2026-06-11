import { createContext, Show, useContext, type ParentProps } from "solid-js"

export function createSimpleContext<T, Props extends Record<string, unknown> = Record<never, never>>(input: {
  name: string
  init: ((props: Props) => T) | (() => T)
}) {
  const ctx = createContext<T>()

  function provider(props: ParentProps<Props>) {
    const value = (input.init as (p: Props) => T)(props)
    return (
        <Show when={(value as Record<string, unknown>).ready === undefined || (value as Record<string, unknown>).ready === true}>
        <ctx.Provider value={value}>{props.children}</ctx.Provider>
      </Show>
    )
  }

  function use(): T {
    const value = useContext(ctx)
    if (value === undefined) throw new Error(`${input.name} context must be used within its provider`)
    return value
  }

  return { context: ctx, provider, use }
}
