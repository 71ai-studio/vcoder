import { Layer } from "effect"
import { TuiConfig } from "./config/tui"
import { Npm } from "@vcoder/core/npm"
import { Observability } from "@vcoder/core/effect/observability"

export const CliLayer = Observability.layer.pipe(Layer.merge(TuiConfig.layer), Layer.provide(Npm.defaultLayer))
