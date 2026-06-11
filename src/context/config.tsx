import { createSimpleContext } from "./helper"
import type { RiteConfig } from "../config/types"

export const {
  use: useConfig,
  provider: ConfigProvider,
} = createSimpleContext({
  name: "Config",
  init: (props: { config: RiteConfig }) => props.config,
})
