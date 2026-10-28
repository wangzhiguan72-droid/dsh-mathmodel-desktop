/**
 * Kimi WebBridge daemon client: one POST /command call per browser action.
 *
 * The daemon lives at `http://127.0.0.1:10086` (installed by
 * `curl -fsSL https://cdn.kimi.com/webbridge/install.sh | bash`). Every
 * request carries a top-level `session` naming the current task; tabs opened
 * under one session form one browser tab group. The daemon answers
 * `{ok:true, data}` on success and `{ok:false, error:{code,message}}` on
 * failure (extension not connected, unknown action, page errors, ...).
 *
 * This module is transport-only: it knows nothing about tools or the model.
 * Every failure path throws a typed DSH {@link WebBridgeError} so the tool
 * registry can retain the daemon's own error code verbatim.
 *
 * @module @dsh-external/dsh-better-browser
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Daemon base URL when the plugin config does not override it. */
export const WEBBRIDGE_DEFAULT_URL = 'http://127.0.0.1:10086'

/** Default per-call timeout budget (ms) for one daemon round-trip. */
export const WEBBRIDGE_DEFAULT_TIMEOUT_MS = 30_000

/** One browser-control command understood by the daemon. */
export type WebBridgeAction =
  | 'navigate'
  | 'find_tab'
  | 'snapshot'
  | 'click'
  | 'fill'
  | 'evaluate'
  | 'screenshot'
  | 'network'
  | 'upload'
  | 'save_as_pdf'
  | 'list_tabs'
  | 'close_tab'
  | 'close_session'

/** Client options. Both fields are validated by the plugin config. */
export interface WebBridgeClientOptions {
  /** Daemon base URL. Defaults to {@link WEBBRIDGE_DEFAULT_URL}. */
  readonly baseUrl?: string
  /** Per-call timeout budget (ms). Defaults to {@link WEBBRIDGE_DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number
}

/** A rejected daemon call (transport, HTTP, or daemon-level rejection). */
export class WebBridgeError extends HarnessError {
  readonly action: WebBridgeAction
  /** Original human-readable daemon/transport detail without the code prefix. */
  readonly detail: string

  constructor(
    message: string,
    code: string,
    action: WebBridgeAction,
  ) {
    // DSH retains `code` structurally for policy and replay, while the model
    // sees the Error message. Prefix it once so both surfaces remain useful.
    super(`${code}: ${message}`, code)
    this.name = 'WebBridgeError'
    this.action = action
    this.detail = message
  }
}

/** Successful daemon payload (`data` is action-specific). */
export interface WebBridgeOk {
  ok: true
  data: Record<string, unknown>
}

/** Validate the resolved client options; throws a loud configuration error. */
export function validateClientOptions(options: WebBridgeClientOptions): Required<WebBridgeClientOptions> {
  const baseUrl = options.baseUrl ?? WEBBRIDGE_DEFAULT_URL
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error(`dsh-better-browser: baseUrl must be an http(s) URL, got ${JSON.stringify(baseUrl)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`dsh-better-browser: baseUrl must be an http(s) URL, got ${JSON.stringify(baseUrl)}`)
  }
  const timeoutMs = options.timeoutMs ?? WEBBRIDGE_DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`dsh-better-browser: timeoutMs must be a positive integer, got ${JSON.stringify(timeoutMs)}`)
  }
  return { baseUrl, timeoutMs }
}

/**
 * Call the daemon once. Every failure — daemon unreachable, non-2xx HTTP
 * status, unparseable body, or the daemon's own `{ok:false}` rejection —
 * throws {@link WebBridgeError} with the daemon's error code when one exists.
 * @param action - one browser-control command.
 * @param args - action-specific arguments.
 * @param session - task/session label grouping this call's tabs.
 * @param options - resolved client options (see {@link validateClientOptions}).
 * @param callerSignal - caller/turn cancellation fused with the local timeout.
 * @returns The daemon's `data` payload on success.
 */
export async function webbridgeCommand(
  action: WebBridgeAction,
  args: Record<string, unknown>,
  session: string,
  options: WebBridgeClientOptions = {},
  callerSignal?: AbortSignal,
): Promise<WebBridgeOk['data']> {
  const { baseUrl, timeoutMs } = validateClientOptions(options)
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const requestSignal = callerSignal === undefined
    ? timeoutSignal
    : AbortSignal.any([callerSignal, timeoutSignal])
  let response: Response
  let rawBody: string
  try {
    response = await fetch(`${baseUrl}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, args, session }),
      // Browser control should not hang forever; the daemon is local.
      signal: requestSignal,
    })
    // The timeout/caller signal also owns the response body read. A daemon
    // that sends headers and then stalls must not escape the same budget.
    rawBody = await response.text()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (callerSignal?.aborted === true) {
      throw new WebBridgeError(
        `kimi-webbridge ${action} request was aborted by the caller`,
        'request_aborted',
        action,
      )
    }
    const timedOut = timeoutSignal.aborted
    throw new WebBridgeError(
      timedOut
        ? `kimi-webbridge daemon at ${baseUrl} did not answer within ${timeoutMs}ms`
        : `kimi-webbridge daemon unreachable at ${baseUrl} (start it with ~/.kimi-webbridge/bin/kimi-webbridge start): ${reason}`,
      timedOut ? 'daemon_timeout' : 'daemon_unreachable',
      action,
    )
  }
  let body: { ok?: unknown; data?: unknown; error?: unknown }
  try {
    body = JSON.parse(rawBody) as typeof body
  } catch {
    if (!response.ok) {
      throw new WebBridgeError(
        `kimi-webbridge daemon returned HTTP ${response.status}`,
        'http_error',
        action,
      )
    }
    throw new WebBridgeError(
      `kimi-webbridge daemon returned a non-JSON body for ${action}`,
      'bad_response',
      action,
    )
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new WebBridgeError(
      response.ok
        ? `kimi-webbridge daemon returned an invalid JSON envelope for ${action}`
        : `kimi-webbridge daemon returned HTTP ${response.status}`,
      response.ok ? 'bad_response' : 'http_error',
      action,
    )
  }
  if (!response.ok) {
    const error = body.error as { code?: unknown; message?: unknown } | undefined
    if (error !== null && typeof error === 'object' && !Array.isArray(error)
      && (typeof error.code === 'string' || typeof error.message === 'string')) {
      throw new WebBridgeError(
        typeof error.message === 'string' ? error.message : `daemon rejected ${action}`,
        typeof error.code === 'string' ? error.code : 'daemon_error',
        action,
      )
    }
    throw new WebBridgeError(
      `kimi-webbridge daemon returned HTTP ${response.status}`,
      'http_error',
      action,
    )
  }
  if (body.ok !== true) {
    const error = body.error as { code?: unknown; message?: unknown } | undefined
    throw new WebBridgeError(
      typeof error?.message === 'string' ? error.message : `daemon rejected ${action}`,
      typeof error?.code === 'string' ? error.code : 'daemon_error',
      action,
    )
  }
  if (typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) {
    throw new WebBridgeError(
      `kimi-webbridge daemon returned no data payload for ${action}`,
      'bad_response',
      action,
    )
  }
  return body.data as Record<string, unknown>
}
