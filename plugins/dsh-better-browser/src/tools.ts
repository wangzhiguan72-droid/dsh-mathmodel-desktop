/**
 * Kimi WebBridge model tools: browser control through the local daemon.
 *
 * Every tool talks to `127.0.0.1:10086` (the kimi-webbridge daemon), which
 * drives the user's REAL browser (their login sessions included) through the
 * WebBridge extension. Tools cover navigation, page reading (accessibility
 * tree snapshot), interaction (click/fill/upload), JS evaluation,
 * screenshots/PDF export, network inspection, and tab management. A single `webbridge_session` parameter names the current
 * task on every call — tabs opened under one session form one tab group.
 *
 * Tools are pure functions of their arguments and the resolved client
 * options: no DSH service is required to build or execute them, which keeps
 * this module unit-testable without a running harness.
 *
 * @module @dsh-external/dsh-better-browser
 */

import { realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView } from '@deepseek-ai/dsh-tools'
import { WebBridgeError, webbridgeCommand, WEBBRIDGE_DEFAULT_TIMEOUT_MS } from './client.ts'
import type { WebBridgeAction, WebBridgeClientOptions } from './client.ts'

/** Session label the model passes with every call (one task = one group). */
const SESSION_ARG = {
  session: {
    type: 'string',
    required: true,
    description: [
      'Task/session name: one task = one name, kept constant across ALL calls of the',
      'task (never switch mid-task — that fragments tab groups). Name it after the',
      'task, not the site (e.g. "camping-research"). Tabs opened under one session',
      'form one browser tab group. On the first navigate of a task, tell the user',
      'once that the task\'s pages are collected under the group\'s visible label, and',
      'that you will close them whenever they ask.',
    ].join(' '),
  },
} as const

/** One tool result as a lossless-JSON value (what the model receives). */
export interface WebBridgeToolResult {
  ok: boolean
  summary: string
  detail: JsonValue
}

const MODEL_OUTPUT_MAX_CHARS = 32_000

/** Fields the next browser step needs even when an auxiliary payload is huge. */
const MODEL_OUTPUT_PRIORITY: Partial<Record<WebBridgeAction, readonly string[]>> = {
  snapshot: ['tree', 'snapshot', 'accessibilityTree', 'content', 'url', 'title'],
  list_tabs: ['tabs'],
  network: ['requestId', 'requests', 'request', 'response', 'responseBody', 'body', 'detail', 'capturing'],
  evaluate: ['value', 'type'],
  screenshot: ['path'],
  save_as_pdf: ['path'],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    detail: { type: 'json' },
  },
} as const

/**
 * Keep the canonical daemon payload visible to the Agent. The compact summary
 * is useful in cards, but it cannot replace the accessibility tree, tab list,
 * network evidence, or generated file path needed by the next tool call.
 */
function modelOutput(action: WebBridgeAction, value: WebBridgeToolResult): string {
  const detail = JSON.stringify(prioritizeModelDetail(action, value.detail), null, 2)
  const full = `${value.summary}\n\nWebBridge ${action} detail:\n${detail}`
  if (full.length <= MODEL_OUTPUT_MAX_CHARS) return full
  const suffix = `\n… [truncated ${full.length - MODEL_OUTPUT_MAX_CHARS} characters]`
  return `${full.slice(0, MODEL_OUTPUT_MAX_CHARS - suffix.length)}${suffix}`
}

/** Preserve every daemon field while placing action-critical evidence first. */
function prioritizeModelDetail(action: WebBridgeAction, detail: JsonValue): JsonValue {
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return detail
  const priority = MODEL_OUTPUT_PRIORITY[action]
  if (priority === undefined) return detail
  const rank = new Map(priority.map((key, index) => [key, index]))
  return Object.fromEntries(
    Object.entries(detail).sort(([left], [right]) => {
      const leftRank = rank.get(left) ?? priority.length
      const rightRank = rank.get(right) ?? priority.length
      return leftRank - rightRank
    }),
  ) as JsonValue
}

/** Shared canonical schema with an action-aware Native/model projection. */
function toolOutput(action: WebBridgeAction) {
  return {
    schema: OUTPUT_SCHEMA,
    render: (_args: unknown, value: WebBridgeToolResult): ContentBlock[] => [{
      type: 'text',
      text: modelOutput(action, value),
    }],
  } as const
}

/** Shared call presentation: a generic card with the action title. */
function present(title: string): (args: Record<string, unknown>) => ToolCallView {
  return args => ({ card: 'generic', title, kind: 'other', rawInput: args })
}

/** Run one daemon action and fold the data payload into the shared output. */
async function run(
  action: WebBridgeAction,
  args: Record<string, unknown>,
  session: string,
  options: WebBridgeClientOptions,
  signal: AbortSignal,
): Promise<WebBridgeToolResult> {
  if (session.trim() === '') {
    throw new WebBridgeError('webbridge session must be a non-empty string', 'invalid_argument', action)
  }
  const data = await webbridgeCommand(action, args, session, options, signal)
  if ((action === 'screenshot' || action === 'save_as_pdf') && data.path !== undefined
    && (typeof data.path !== 'string' || !safeOutputPath(action, data.path))) {
    throw new WebBridgeError(
      `kimi-webbridge daemon returned an unsafe ${action} path`,
      'bad_response',
      action,
    )
  }
  return { ok: true, summary: compactSummary(data), detail: data as JsonValue }
}

/** Accept output only from the daemon's dedicated temp directory. */
function safeOutputPath(action: 'screenshot' | 'save_as_pdf', value: string): boolean {
  if (!isAbsolute(value)) return false
  const directory = action === 'screenshot' ? 'kimi-webbridge-screenshots' : 'kimi-webbridge-pdfs'
  const roots = [resolve(tmpdir(), directory)]
  // The daemon documentation uses /tmp while macOS commonly exposes the same
  // temp area through TMPDIR or /private/tmp; accept those dedicated aliases.
  if (sep === '/') roots.push(resolve('/tmp', directory), resolve('/private/tmp', directory))
  const target = resolve(value)
  return roots.some((root) => {
    const child = relative(root, target)
    return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
  })
}

/** Keep browser navigation on web origins; never expose local/script schemes. */
function webUrl(value: string, action: 'navigate' | 'find_tab'): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new WebBridgeError(`${action} URL must be an absolute http(s) URL`, 'invalid_argument', action)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WebBridgeError(`${action} URL must be an absolute http(s) URL`, 'invalid_argument', action)
  }
  return value
}

/** Validate host paths before handing them to the privileged browser bridge. */
async function uploadFiles(values: readonly string[], workspace: string | undefined): Promise<string[]> {
  if (values.length === 0) {
    throw new WebBridgeError('upload requires at least one file', 'invalid_argument', 'upload')
  }
  if (workspace === undefined || workspace.trim() === '' || !isAbsolute(workspace)) {
    throw new WebBridgeError('upload requires a calling Agent workspace', 'invalid_argument', 'upload')
  }
  let workspaceRoot: string
  try {
    workspaceRoot = await realpath(workspace)
  } catch {
    throw new WebBridgeError('upload Agent workspace is unavailable', 'invalid_argument', 'upload')
  }
  const files = [...values]
  for (const file of files) {
    if (!isAbsolute(file)) {
      throw new WebBridgeError(`upload path must be absolute: ${JSON.stringify(file)}`, 'invalid_argument', 'upload')
    }
    let info
    let canonicalFile: string
    try {
      info = await stat(file)
      canonicalFile = await realpath(file)
    } catch {
      throw new WebBridgeError(`upload file does not exist: ${JSON.stringify(file)}`, 'invalid_argument', 'upload')
    }
    if (!info.isFile()) {
      throw new WebBridgeError(`upload path is not a file: ${JSON.stringify(file)}`, 'invalid_argument', 'upload')
    }
    const child = relative(workspaceRoot, canonicalFile)
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new WebBridgeError(`upload file is outside the Agent workspace: ${JSON.stringify(file)}`, 'invalid_argument', 'upload')
    }
  }
  return files
}

/** A PDF name is a basename, never a path interpreted by the daemon. */
function pdfFileName(value: string): string {
  const hasControlCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
  if (value.trim() === '' || value === '.' || value === '..' || /[\\/]/.test(value) || hasControlCharacter) {
    throw new WebBridgeError('PDF file_name must be a safe basename', 'invalid_argument', 'save_as_pdf')
  }
  return value
}

/** Build a compact one-line summary from an action payload. */
function compactSummary(data: Record<string, unknown>): string {
  const parts: string[] = []
  for (const key of ['url', 'title', 'success', 'tabId', 'mode', 'format', 'sizeBytes', 'type']) {
    const value = data[key]
    if (value !== undefined && value !== null) parts.push(`${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
  }
  if (parts.length > 0) return parts.join(' ')
  const text = JSON.stringify(data)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/** Registry-ready tool set. `options` overrides the daemon address and budget (tests). */
export function webbridgeTools(options: WebBridgeClientOptions = {}) {
  const timeoutMs = options.timeoutMs ?? WEBBRIDGE_DEFAULT_TIMEOUT_MS
  const navigate = defineTool({
    timeoutMs,
    isConcurrencySafe: () => false,
    name: 'webbridge_navigate',
    description: [
      'Open a URL in the user\'s real browser (their login sessions included) and make',
      'that tab the current one. Use newTab=true when pages should coexist; omit it to',
      'send the current tab to a new URL. group_title sets the tab group\'s visible',
      'label (write it in the user\'s language).',
    ].join(' '),
    parameters: {
      ...SESSION_ARG,
      url: { type: 'string', required: true, description: 'Full URL to open (https://…).' },
      newTab: { type: 'boolean', description: 'Open in a new tab (default false).' },
      group_title: { type: 'string', description: 'Human-readable label for the tab group, set on the first navigate of a task.' },
    },
    output: toolOutput('navigate'),
    presentCall: present('Open in browser'),
    execute: async (args, exec) => run('navigate', {
      url: webUrl(String(args.url), 'navigate'),
      ...(args.newTab === true ? { newTab: true } : {}),
      ...(typeof args.group_title === 'string' && args.group_title !== '' ? { group_title: args.group_title } : {}),
    }, String(args.session), options, exec.signal),
  })

  const findTab = defineTool({
    timeoutMs,
    isConcurrencySafe: () => false,
    name: 'webbridge_find_tab',
    description: [
      'Re-select a tab this task opened (or, with active=true, borrow the tab the user',
      'is currently viewing). Pass the tab\'s full URL from list_tabs or the earlier',
      'navigate result. Prefer this over opening a duplicate when the page may',
      'already be open in this session.',
    ].join(' '),
    parameters: {
      ...SESSION_ARG,
      url: { type: 'string', required: true, description: 'Full URL of the tab to select.' },
      active: { type: 'boolean', description: 'Borrow the tab the user is currently viewing (default false).' },
    },
    output: toolOutput('find_tab'),
    presentCall: present('Select browser tab'),
    execute: async (args, exec) => run('find_tab', {
      url: webUrl(String(args.url), 'find_tab'),
      ...(args.active === true ? { active: true } : {}),
    }, String(args.session), options, exec.signal),
  })

  const snapshot = defineTool({
    timeoutMs,
    isConcurrencySafe: () => false,
    name: 'webbridge_snapshot',
    description: [
      'Read the current page\'s accessibility tree (interactive elements with @e refs,',
      'text content, headings, links, buttons). Use this to understand what is on the',
      'page and to locate elements for click/fill. Prefer this over CSS selectors:',
      '@e refs survive CSS class hash changes.',
    ].join(' '),
    parameters: { ...SESSION_ARG },
    output: toolOutput('snapshot'),
    presentCall: present('Snapshot page'),
    execute: async (args, exec) => run('snapshot', {}, String(args.session), options, exec.signal),
  })

  const click = defineTool({
    timeoutMs,
    isConcurrencySafe: () => false,
    name: 'webbridge_click',
    description: [
      'Click an element on the current page. Pass the @e ref from snapshot (e.g. @e12)',
      'or a CSS selector. Fires a DOM-level synthetic click — sites that strictly',
      'check event.isTrusted (banking portals, captchas) may ignore it.',
    ].join(' '),
    parameters: {
      ...SESSION_ARG,
      selector: { type: 'string', required: true, description: '@e ref from snapshot or a CSS selector.' },
    },
    output: toolOutput('click'),
    presentCall: present('Click element'),
    execute: async (args, exec) => run('click', { selector: String(args.selector) }, String(args.session), options, exec.signal),
  })

  const fill = defineTool({
    timeoutMs,
    isConcurrencySafe: () => false,
    name: 'webbridge_fill',
    description: [
      'Type into an input, textarea, or contenteditable rich editor (ProseMirror,',
      'TipTap, Lexical, Slate, Quill). Clear-and-insert: existing content is',
      'replaced. To append, read the current value via evaluate first.',
    ].join(' '),
    parameters: {
      ...SESSION_ARG,
      selector: { type: 'string', required: true, description: '@e ref from snapshot or a CSS selector.' },
      value: { type: 'string', required: true, description: 'Text to insert.' },
    },
    output: toolOutput('fill'),
    presentCall: present('Fill input'),
    execute: async (args, exec) => run('fill', { selector: String(args.selector), value: String(args.value) }, String(args.session), options, exec.signal),
  })

  const evaluate = defineTool({
    timeoutMs,
    isConcurrencySafe: () => false,
    name: 'webbridge_evaluate',
    description: [
      'Run JavaScript in the current page (async/await supported). Use for reading',
      'attributes, dispatching complex event sequences, or scrolling. Wrap',
      're-declarations in an IIFE — evaluate calls share the page\'s JS realm.',
    ].join(' '),
    parameters: {
      ...SESSION_ARG,
      code: { type: 'string', required: true, description: 'JavaScript expression to evaluate (compact, no formatting whitespace).' },
    },
    output: toolOutput('evaluate'),
    presentCall: present('Evaluate JS'),
    execute: async (args, exec) => run('evaluate', { code: String(args.code) }, String(args.session), options, exec.signal),
  })

  const screenshot = defineTool({
    timeoutMs,
    isConcurrencySafe: () => false,
    name: 'webbridge_screenshot',
    description: [
      'Screenshot the current page (or one element via selector). Returns a file',
      'path on disk — read the file to see the image. Use for visual verification',
      'of the current browser state.',
    ].join(' '),
    parameters: {
      ...SESSION_ARG,
      format: { type: 'string', enum: ['png', 'jpeg'], description: 'png (default) or jpeg.' },
      quality: { type: 'integer', description: 'JPEG quality 0-100 (default 80).' },
      selector: { type: 'string', description: '@e ref or CSS selector to capture just that element.' },
    },
    output: toolOutput('screenshot'),
    presentCall: present('Screenshot page'),
    execute: async (args, exec) => {
      if (typeof args.quality === 'number' && (!Number.isInteger(args.quality) || args.quality < 0 || args.quality > 100)) {
        throw new WebBridgeError('screenshot quality must be an integer from 0 to 100', 'invalid_argument', 'screenshot')
      }
      return run('screenshot', {
        ...(typeof args.format === 'string' ? { format: args.format } : {}),
        ...(typeof args.quality === 'number' ? { quality: args.quality } : {}),
        ...(typeof args.selector === 'string' && args.selector !== '' ? { selector: args.selector } : {}),
      }, String(args.session), options, exec.signal)
    },
  })

  const listTabs = defineTool({
    timeoutMs,
    isConcurrencySafe: () => false,
    name: 'webbridge_list_tabs',
    description: 'List the tabs opened in this task session (tabId, url, title, active).',
    parameters: { ...SESSION_ARG },
    output: toolOutput('list_tabs'),
    presentCall: present('List session tabs'),
    execute: async (args, exec) => run('list_tabs', {}, String(args.session), options, exec.signal),
  })

  const network = defineTool({
    timeoutMs,
    isConcurrencySafe: () => false,
    name: 'webbridge_network',
    description: [
      'Inspect network activity of the current page: start/stop capturing, list',
      'captured requests, or get request/response detail by requestId. Use for',
      'debugging API calls and verifying page behavior.',
    ].join(' '),
    parameters: {
      ...SESSION_ARG,
      cmd: { type: 'string', required: true, enum: ['start', 'stop', 'list', 'detail'], description: 'start | stop | list | detail.' },
      filter: { type: 'string', description: 'URL filter for start/list.' },
      requestId: { type: 'string', description: 'requestId for detail.' },
    },
    output: toolOutput('network'),
    presentCall: present('Inspect network'),
    execute: async (args, exec) => run('network', {
      cmd: String(args.cmd),
      ...(typeof args.filter === 'string' && args.filter !== '' ? { filter: args.filter } : {}),
      ...(typeof args.requestId === 'string' && args.requestId !== '' ? { requestId: args.requestId } : {}),
    }, String(args.session), options, exec.signal),
  })

  const closeTab = defineTool({
    timeoutMs,
    isConcurrencySafe: () => false,
    name: 'webbridge_close_tab',
    description: 'Close the current tab of this task session.',
    parameters: { ...SESSION_ARG },
    output: toolOutput('close_tab'),
    presentCall: present('Close session tab'),
    execute: async (args, exec) => run('close_tab', {}, String(args.session), options, exec.signal),
  })

  const closeSession = defineTool({
    timeoutMs,
    isConcurrencySafe: () => false,
    name: 'webbridge_close_session',
    description: [
      'Close ALL tabs of this task session (one call clears the whole tab group).',
      'CLOSING IS USER-INITIATED: call this ONLY when the user explicitly asks to',
      'close/clear the tabs ("close those", "clear the tabs"). Never close tabs',
      'automatically at the end of a task — the user decides when to dismiss them.',
    ].join(' '),
    parameters: { ...SESSION_ARG },
    output: toolOutput('close_session'),
    presentCall: present('Close task tab group'),
    execute: async (args, exec) => run('close_session', {}, String(args.session), options, exec.signal),
  })

  const upload = defineTool({
    timeoutMs,
    isConcurrencySafe: () => false,
    name: 'webbridge_upload',
    description: [
      'Upload files through a file input on the current page. Pass the @e ref',
      'or CSS selector of the file input and absolute paths of the files to',
      'upload (they must exist inside the calling Agent workspace). Use for attaching documents,',
      'images, or data files the task needs to submit.',
    ].join(' '),
    parameters: {
      ...SESSION_ARG,
      selector: { type: 'string', required: true, description: '@e ref from snapshot or a CSS selector of the file input.' },
      files: { type: 'array', items: { type: 'string' }, required: true, description: 'Absolute paths inside the calling Agent workspace.' },
    },
    output: toolOutput('upload'),
    presentCall: present('Upload files'),
    execute: async (args, exec) => run('upload', {
      selector: String(args.selector),
      files: await uploadFiles(args.files.map(file => String(file)), exec.agent?.session.header.cwd),
    }, String(args.session), options, exec.signal),
  })

  const saveAsPdf = defineTool({
    timeoutMs,
    isConcurrencySafe: () => false,
    name: 'webbridge_save_as_pdf',
    description: [
      'Render the current page to a PDF file on this machine (saved under',
      '/tmp/kimi-webbridge-pdfs/). Returns the file path — read the file to',
      'verify or deliver it. Use for archiving pages, generating reports, or',
      'producing a shareable document of the current browser state.',
    ].join(' '),
    parameters: {
      ...SESSION_ARG,
      paper_format: { type: 'string', description: 'Paper format, e.g. "a4" (default) or "letter".' },
      landscape: { type: 'boolean', description: 'Landscape orientation (default false).' },
      scale: { type: 'number', description: 'Scale factor, e.g. 0.8 (default 1).' },
      print_background: { type: 'boolean', description: 'Print background graphics (default true).' },
      file_name: { type: 'string', description: 'Output file name (without extension).' },
    },
    output: toolOutput('save_as_pdf'),
    presentCall: present('Save page as PDF'),
    execute: async (args, exec) => {
      if (typeof args.scale === 'number' && args.scale <= 0) {
        throw new WebBridgeError('PDF scale must be greater than zero', 'invalid_argument', 'save_as_pdf')
      }
      return run('save_as_pdf', {
        ...(typeof args.paper_format === 'string' && args.paper_format !== '' ? { paper_format: args.paper_format } : {}),
        ...(args.landscape === true ? { landscape: true } : {}),
        ...(typeof args.scale === 'number' ? { scale: args.scale } : {}),
        ...(args.print_background === false ? { print_background: false } : {}),
        ...(typeof args.file_name === 'string' && args.file_name !== '' ? { file_name: pdfFileName(args.file_name) } : {}),
      }, String(args.session), options, exec.signal)
    },
  })

  return { navigate, findTab, snapshot, click, fill, evaluate, screenshot, listTabs, network, upload, saveAsPdf, closeTab, closeSession }
}

/** Names of every tool the plugin registers, in registry order. */
export const WEBBRIDGE_TOOL_NAMES = [
  'webbridge_navigate',
  'webbridge_find_tab',
  'webbridge_snapshot',
  'webbridge_click',
  'webbridge_fill',
  'webbridge_evaluate',
  'webbridge_screenshot',
  'webbridge_list_tabs',
  'webbridge_network',
  'webbridge_upload',
  'webbridge_save_as_pdf',
  'webbridge_close_tab',
  'webbridge_close_session',
] as const

/** Defaults re-exported so composition bundles can surface them in docs. */
export { WEBBRIDGE_DEFAULT_TIMEOUT_MS, WEBBRIDGE_DEFAULT_URL } from './client.ts'
