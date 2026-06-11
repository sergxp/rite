import { createSignal, type ParentProps } from "solid-js"
import { createSimpleContext } from "./helper"

export type RouteData =
  | { type: "home" }
  | { type: "session"; sessionId: string }

export const {
  use: useRoute,
  provider: RouteProvider,
} = createSimpleContext({
  name: "Route",
  init: (props: { initialSessionId?: string }) => {
    const initial: RouteData = props.initialSessionId
      ? { type: "session", sessionId: props.initialSessionId }
      : { type: "home" }

    const [data, setData] = createSignal<RouteData>(initial)

    function navigate(next: RouteData) {
      setData(next)
    }

    return { data, navigate }
  },
})
