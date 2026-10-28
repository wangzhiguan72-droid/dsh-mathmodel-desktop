// Route the pinned web family's update seat through the installed desktop app.
// Only staged copies are edited; npm/browser installations keep their own flow.
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const legacyNames = ['@linxin666/dsh-web-all', '@linxin666/dsh-remote-web-ui']
const marker = 'function DesktopUpdateEntry({ wide }) {'
const clientAnchor = '\t\tfunction UpdateEntry({ wide, t }) {'
const statusAnchor = '\t\twriteJson(res, 200, await deps.check());'
const runAnchor = '\t\twriteJson(res, 200, await deps.run());'

function replaceOne(source, before, after) {
  const first = source.indexOf(before)
  if (first < 0 || source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`Desktop update patch anchor missing or ambiguous: ${before.slice(0, 65)}`)
  }
  return source.slice(0, first) + after + source.slice(first + before.length)
}

const desktopEntry = `\t\tfunction DesktopUpdateEntry({ wide }) {
\t\t\tconst bridge = window.desktopUpdates;
\t\t\tconst [state, setState] = (0, react.useState)({ phase: "idle" });
\t\t\t(0, react.useEffect)(() => {
\t\t\t\tlet active = true;
\t\t\t\tlet revision = 0;
\t\t\t\tconst unsubscribe = bridge.onState((next) => { if (active && next) { revision++; setState(next); } });
\t\t\t\tconst initialRevision = revision;
\t\t\t\tPromise.resolve().then(() => bridge.getState()).then(
\t\t\t\t\t(next) => { if (active && revision === initialRevision && next) setState(next); },
\t\t\t\t\t(error) => { if (active && revision === initialRevision) setState({ phase: "error", detail: String(error?.message ?? error) }); }
\t\t\t\t);
\t\t\t\treturn () => { active = false; if (typeof unsubscribe === "function") unsubscribe(); };
\t\t\t}, [bridge]);
\t\t\tconst available = state.phase === "available" || state.phase === "ready";
\t\t\tconst busy = state.phase === "checking" || state.phase === "downloading" || state.phase === "installing";
\t\t\tconst label = state.phase === "checking" ? "正在检查更新…"
\t\t\t\t: state.phase === "downloading" ? "正在准备更新…"
\t\t\t\t: state.phase === "installing" ? "正在重启…"
\t\t\t\t: available ? (state.phase === "ready" ? "安装更新 · " : "桌面更新 · ") + (state.availableVersion ?? "")
\t\t\t\t: "桌面版 " + (state.currentVersion ?? "");
\t\t\treturn /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
\t\t\t\ttype: "button",
\t\t\t\tclassName: remote_module_css_default.trigger,
\t\t\t\t"data-desktop-update-entry": "true",
\t\t\t\t"data-wide": wide ? available ? "wide" : void 0 : "rail",
\t\t\t\t"data-update-available": available ? "true" : void 0,
\t\t\t\t"aria-label": label,
\t\t\t\ttitle: state.detail || label,
\t\t\t\tdisabled: busy,
\t\t\t\tonClick: () => { Promise.resolve().then(() => bridge.open()).catch((error) => setState({ phase: "error", detail: String(error?.message ?? error) })); },
\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconDownloadOutline16, { size: wide ? 16 : 18 }), wide && available && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: remote_module_css_default.updateBadgeText, children: label })]
\t\t\t});
\t\t}
`

export function patchDesktopClientSource(source) {
  if (source.includes(marker)) {
    if (!source.includes('return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DesktopUpdateEntry, { wide });')) {
      throw new Error('Partial desktop update entry patch')
    }
    return source
  }
  const entry = source.includes('var update_module_css_default =')
    ? desktopEntry.replaceAll('remote_module_css_default', 'update_module_css_default')
      .replaceAll('IconDownloadOutline16', 'IconDownloadOutlineRegular')
    : desktopEntry
  return replaceOne(source, clientAnchor,
    entry + clientAnchor + '\n\t\t\tif (typeof window !== "undefined" && window.desktopUpdates && typeof window.desktopUpdates.getState === "function" && typeof window.desktopUpdates.onState === "function" && typeof window.desktopUpdates.open === "function") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DesktopUpdateEntry, { wide });')
}

export function patchDesktopServerSource(source) {
  if (source.includes('errorCode: "desktop-managed"')) {
    if (!source.includes('mode: "desktop", outdated: false, packages: []')) throw new Error('Partial desktop update route patch')
    return source
  }
  let result = replaceOne(source, statusAnchor,
    '\t\tif (process.env.DSH_DESKTOP_MANAGED_UPDATES === "1") {\n\t\t\twriteJson(res, 200, { mode: "desktop", outdated: false, packages: [] });\n\t\t\treturn;\n\t\t}\n' + statusAnchor)
  result = replaceOne(result, runAnchor,
    '\t\tif (process.env.DSH_DESKTOP_MANAGED_UPDATES === "1") {\n\t\t\twriteJson(res, 409, { ok: false, errorCode: "desktop-managed", error: "请使用桌面更新入口。" });\n\t\t\treturn;\n\t\t}\n' + runAnchor)
  return result
}

export async function patchDesktopUpdateProfile(profileDir) {
  const aggregatePath = path.join(profileDir, 'node_modules', '@linxin666', 'dsh-web-all')
  const aggregate = JSON.parse(await readFile(path.join(aggregatePath, 'package.json'), 'utf8'))
  if (aggregate.name !== '@linxin666/dsh-web-all' || !['0.3.23', '0.4.5', '0.4.7', '0.4.11'].includes(aggregate.version)) {
    throw new Error(`Unsupported desktop update family: ${aggregate.name}@${aggregate.version}`)
  }
  const version = aggregate.version
  // From 0.4.11 the aggregate is a thin loader; only dsh-update carries the entry.
  const names = version === '0.3.23' ? legacyNames
    : version === '0.4.11' ? ['@linxin666/dsh-update'] : ['@linxin666/dsh-web-all', '@linxin666/dsh-update']
  const serverName = version === '0.3.23' ? 'dsh-remote-web-ui' : 'dsh-update'
  const candidates = []
  for (const name of names) {
    const packageDir = path.join(profileDir, 'node_modules', ...name.split('/'))
    const meta = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'))
    if (meta.name !== name || meta.version !== version) {
      throw new Error(`Unsupported desktop update package: ${meta.name}@${meta.version}`)
    }
    const clientPath = path.join(packageDir, 'lib', 'client.js')
    const before = await readFile(clientPath, 'utf8')
    candidates.push({ file: clientPath, before, after: patchDesktopClientSource(before) })
  }
  const serverPath = path.join(profileDir, 'node_modules', '@linxin666', serverName, 'lib', 'index.js')
  const before = await readFile(serverPath, 'utf8')
  candidates.push({ file: serverPath, before, after: patchDesktopServerSource(before) })
  // Every pinned package and anchor is validated before the first write.
  for (const { file, before: old, after } of candidates) if (old !== after) await writeFile(file, after)
  return { changed: candidates.some(({ before: old, after }) => old !== after), files: candidates.map(({ file }) => file) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/patch-desktop-update-entry.mjs <staged-profile-directory>')
  const result = await patchDesktopUpdateProfile(path.resolve(process.argv[2]))
  console.log(`Desktop update entry ${result.changed ? 'patched' : 'already applied'}: ${result.files.join(', ')}`)
}
