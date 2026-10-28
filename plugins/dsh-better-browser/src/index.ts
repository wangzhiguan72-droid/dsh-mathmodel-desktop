/**
 * dsh-better-browser host plugin: registers the Kimi WebBridge model tools
 * (browser control through the local kimi-webbridge daemon).
 *
 * The daemon is installed independently (`curl -fsSL
 * https://cdn.kimi.com/webbridge/install.sh | bash`) and runs at
 * `http://127.0.0.1:10086`. The plugin surfaces it to the model as
 * `webbridge_*` tools; every call names a session (task), and the user's
 * real browser (with their logins) is the controlled surface.
 *
 * The plugin is host-only and non-destructive: it only registers tools on
 * the `tools` service through fiber-scoped effects, so disabling or removing
 * the plugin leaves the harness exactly as it was. It never touches the
 * agent loop, sessions, or any other seam. The bundle's composition row keeps
 * the stable `webbridge` id used by existing profile overlays and the tool
 * protocol. Loader row ids are unique, so profiles must not mount a second
 * bundle with that id at the same time.
 *
 * @module @dsh-external/dsh-better-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import { validateClientOptions, WEBBRIDGE_DEFAULT_TIMEOUT_MS, WEBBRIDGE_DEFAULT_URL } from './client.ts'
import type { WebBridgeClientOptions } from './client.ts'
import { webbridgeTools } from './tools.ts'

/** Stable plugin name used by loader diagnostics. */
export const name = 'dsh-better-browser'

/** Services required by the plugin. */
export const inject = ['tools']

/** Plugin config: daemon address and per-call timeout budget. */
export interface Config {
  /** Daemon base URL. Defaults to {@link WEBBRIDGE_DEFAULT_URL}. */
  baseUrl?: string
  /** Per-call timeout budget (ms). Defaults to {@link WEBBRIDGE_DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().default(WEBBRIDGE_DEFAULT_URL),
  timeoutMs: z.number().default(WEBBRIDGE_DEFAULT_TIMEOUT_MS),
})

/**
 * Mount the plugin: register every `webbridge_*` tool on `ctx.tools`.
 * Each registration is a fiber-scoped effect, so a plugin reload or disable
 * unregisters the tools and leaves no residue.
 * @param ctx - host root context.
 * @param config - validated plugin config (schemastery defaults applied).
 */
export function apply(ctx: Context, config: Config): void {
  const options: WebBridgeClientOptions = validateClientOptions({
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
  })
  const tools = webbridgeTools(options)
  for (const tool of Object.values(tools)) {
    ctx.effect(
      () => ctx.tools.register(tool),
      `dsh-better-browser: register ${tool.name}`,
    )
  }
}

export { WEBBRIDGE_DEFAULT_TIMEOUT_MS, WEBBRIDGE_DEFAULT_URL } from './client.ts'
export { webbridgeTools, WEBBRIDGE_TOOL_NAMES } from './tools.ts'
export type { WebBridgeAction, WebBridgeClientOptions, WebBridgeOk } from './client.ts'
export { WebBridgeError, webbridgeCommand } from './client.ts'
