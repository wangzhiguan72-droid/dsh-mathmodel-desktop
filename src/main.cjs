'use strict';

/**
 * DeepSeek Harness desktop — Electron main process.
 *
 * The app owns one dsh host child process: it seeds $DSH_HOME/profiles/<name>
 * (this edition's dedicated `mathmodel` profile, overridable via DSH_PROFILE)
 * from the bundled profile when needed, spawns the bundled Node runtime on a
 * dedicated loopback port (never the plain `dsh web` defaults 3080/3081),
 * waits for the GUI, and loads the tokenized URL the host prints. The host is
 * this app's own separate instance — it runs next to any `dsh web` the user
 * starts themselves, and this app owns its full lifecycle (graceful stop on
 * quit, forced after 5s).
 */

const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  resolveRuntimePaths,
  resolveDshHome,
  resolveProfileName,
  childEnv,
  readStampFile,
  profileAction,
  applyProfileSeed,
  findHostPort,
  waitForGui,
  parseTokenUrlLine,
  ensureProfileFallbacks,
  checkVcRuntime,
  isProgrammaticLaunch,
} = require('./runtime.cjs');

const READY_TIMEOUT_MS = 180000;
const LOG_TAIL_LINES = 200;
/** The host prints its tokenized GUI URL on this stdout line. */

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {import('node:child_process').ChildProcess | null} */
let hostChild = null;
let quitting = false;
let logStream = null;
/** URL printed by the host (with the per-process token), set once seen. */
let tokenUrl = null;
/** Ring buffer of recent host output for the error page. */
const logTail = [];

function resourcesRoot() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources');
}

function logFilePath() {
  return path.join(app.getPath('logs'), 'dsh-host.log');
}

function pushLogLine(line) {
  logTail.push(line);
  if (logTail.length > LOG_TAIL_LINES) logTail.shift();
  if (logStream !== null) logStream.write(line + '\n');
  const url = parseTokenUrlLine(line);
  if (url !== undefined) tokenUrl = url;
}

function setStatus(text) {
  if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:status', text);
}

function startHost(runtime, home, port, profileName) {
  const nodePaths = [
    path.join(runtime.runtimeRoot, 'host', 'node_modules'),
    path.join(home, 'profiles', 'node_modules'),
  ];
  if (process.platform === 'win32' && process.env.APPDATA) {
    const globalNpm = path.join(process.env.APPDATA, 'npm', 'node_modules');
    if (fs.existsSync(globalNpm)) nodePaths.push(globalNpm);
  }
  // `dsh web` is hardcoded to the `web` profile; a custom profile boots via
  // `dsh --profile <name>` with the web app's own flags following.
  const args = [runtime.hostBin, '--profile', profileName, '--no-open', '--host', '127.0.0.1', '--port', String(port)];
  const child = spawn(runtime.nodeBin, args, {
    cwd: home,
    env: childEnv(home, runtime.nodeHome, process.platform, process.env, nodePaths),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const onData = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line !== '') pushLogLine(line);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  return child;
}

function stopHost(child) {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise();
      return;
    }
    const force = setTimeout(() => {
      if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => resolvePromise());
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
        resolvePromise();
      }
    }, 5000);
    child.once('exit', () => {
      clearTimeout(force);
      resolvePromise();
    });
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T'], () => { /* graceful attempt only */ });
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'DeepSeek 数学建模版',
    backgroundColor: '#0b1220',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url) && !url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  return window;
}

async function showError(message) {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  await mainWindow.loadFile(path.join(__dirname, 'error.html'));
  mainWindow.webContents.send('desktop:error', {
    message,
    log: logTail.join('\n'),
    logFile: logFilePath(),
  });
}

async function boot() {
  const runtime = resolveRuntimePaths(resourcesRoot(), process.platform, process.arch, app.isPackaged);
  const home = resolveDshHome(process.env, os.homedir());
  pushLogLine('[desktop] dsh home: ' + home);

  if (process.platform === 'win32' && !checkVcRuntime()) {
    pushLogLine('[desktop] warning: Visual C++ runtime (vcruntime140.dll) is missing');
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      void dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['前往微软官网下载 (Download)', '稍后手动安装 (Later)'],
        defaultId: 0,
        cancelId: 1,
        title: '缺少系统组件 (Prerequisite Missing)',
        message: '检测到当前系统缺少微软 Visual C++ 运行库（vcruntime140.dll）。',
        detail: '没有该运行库，后台 Node 宿主服务可能无法启动。建议立即安装后再使用。',
      }).then((result) => {
        if (result.response === 0) {
          void shell.openExternal('https://aka.ms/vs/17/release/vc_redist.x64.exe');
        }
      });
    }
  }

  if (!fs.existsSync(runtime.nodeBin)) throw new Error('bundled Node runtime is missing: ' + runtime.nodeBin);
  if (!fs.existsSync(runtime.hostBin)) throw new Error('bundled dsh host is missing: ' + runtime.hostBin);

  const stamp = readStampFile(runtime.stampFile);
  const stampText = stamp === undefined ? 'unknown' : [stamp.node, stamp.host, stamp.webAll].join(' / ');
  const profileName = resolveProfileName(process.env);
  pushLogLine('[desktop] dsh profile: ' + profileName);
  const profileDir = path.join(home, 'profiles', profileName);
  const action = profileAction(profileDir, stampText);
  if (action !== 'leave') {
    setStatus('Installing the bundled ' + profileName + ' profile…');
    pushLogLine('[desktop] profile action: ' + action + ' (' + stampText + ')');
    applyProfileSeed(runtime.profileSeed, profileDir, action, stampText, { appVersion: app.getVersion() });
  }

  try {
    ensureProfileFallbacks(home, path.join(runtime.runtimeRoot, 'host'), profileName);
  } catch (error) {
    pushLogLine('[desktop] fallback healing warning: ' + String(error && error.message ? error.message : error));
  }

  setStatus('Starting the dsh host…');
  const port = await findHostPort();
  pushLogLine('[desktop] spawning the desktop host on 127.0.0.1:' + port
    + ' (the user\u2019s own dsh web defaults 3080/3081 are never taken)');
  hostChild = startHost(runtime, home, port, profileName);
  const child = hostChild;
  let exited = false;
  child.once('exit', (code, signal) => {
    exited = true;
    pushLogLine('[desktop] host exited: code=' + String(code) + ' signal=' + String(signal));
    if (!quitting) void showError('The dsh host process stopped unexpectedly.');
  });
  await waitForGui(port, { deadlineMs: READY_TIMEOUT_MS, isAlive: () => !exited });
  // The token URL line can land a moment after the port answers; give it a
  // short grace period before falling back to the bare (401) URL.
  for (let waited = 0; tokenUrl === null && waited < 5000; waited += 250) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  const target = tokenUrl ?? ('http://127.0.0.1:' + port + '/');
  pushLogLine('[desktop] GUI ready, loading ' + (tokenUrl === null ? 'the bare URL (no token line seen)' : 'the tokenized URL'));
  await mainWindow.loadURL(target);
}

async function run() {
  mainWindow = createWindow();
  await mainWindow.loadFile(path.join(__dirname, 'splash.html'));
  try {
    await boot();
  } catch (error) {
    pushLogLine('[desktop] boot failed: ' + String(error && error.message ? error.message : error));
    await showError(String(error && error.message ? error.message : error));
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    // Programmatic spawns of this executable (doctor supervisor and
    // provisioning children, CLI helpers) must never raise the window: they
    // are headless Node children that fail the single-instance lock on
    // purpose, and focusing on every retry is the #1382 popup loop.
    if (isProgrammaticLaunch(argv)) return;
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(run).catch((error) => {
    console.error(error);
    app.quit();
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  if (hostChild !== null) {
    event.preventDefault();
    const child = hostChild;
    hostChild = null;
    void stopHost(child).then(() => app.quit());
  }
});

ipcMain.on('desktop:retry', () => {
  if (quitting) return;
  void run();
});

ipcMain.on('desktop:reveal-log', () => {
  shell.showItemInFolder(logFilePath());
});

ipcMain.on('desktop:quit', () => {
  app.quit();
});

app.whenReady().then(() => {
  try {
    fs.mkdirSync(path.dirname(logFilePath()), { recursive: true });
    logStream = fs.createWriteStream(logFilePath(), { flags: 'a' });
  } catch {
    logStream = null;
  }
  setupStableSnapshotMenu();
});

/**
 * 稳定版快照：把当前 resources/runtime 完整备份到用户数据目录，
 * 供更新失败时一键回滚。只保留最近 3 份，更早的自动清理。
 */
function stableBackupRoot() {
  return path.join(app.getPath('userData'), 'runtime-stable-backups');
}

async function snapshotStableRuntime() {
  const runtimeSrc = path.join(resourcesRoot(), 'runtime');
  if (!fs.existsSync(runtimeSrc)) throw new Error('未找到运行时目录：' + runtimeSrc);
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const dest = path.join(stableBackupRoot(), 'runtime-' + stamp);
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons: ['开始备份', '取消'],
    defaultId: 0,
    cancelId: 1,
    title: '保存稳定版快照',
    message: '把当前正在稳定使用的完整运行时备份下来吗？',
    detail: '备份位置：' + dest + '\n完整运行时约 5GB，需要几分钟；更新失败时可用备份一键回滚。只保留最近 3 份。',
  }).then((result) => {
    if (result.response !== 0) throw new Error('canceled');
  });
  await dialog.showMessageBox(mainWindow, {
    type: 'info', buttons: ['知道了'], title: '正在备份',
    message: '正在备份，请勿关闭应用（完成后会再提示）。',
  });
  await fs.promises.cp(runtimeSrc, dest, { recursive: true, verbatimSymlinks: true });
  // 只保留最近 3 份
  const root = stableBackupRoot();
  const snaps = fs.readdirSync(root).filter((n) => n.startsWith('runtime-')).sort().reverse();
  for (const stale of snaps.slice(3)) {
    fs.rmSync(path.join(root, stale), { recursive: true, force: true });
  }
  await dialog.showMessageBox(mainWindow, {
    type: 'info', buttons: ['知道了'], title: '稳定版快照已保存',
    message: '稳定版快照已保存到：' + dest,
    detail: '更新失败需要回滚时，在菜单选择"恢复稳定版快照"即可。',
  });
}

async function restoreStableRuntime() {
  const root = stableBackupRoot();
  const snaps = fs.existsSync(root)
    ? fs.readdirSync(root).filter((n) => n.startsWith('runtime-')).sort().reverse()
    : [];
  if (snaps.length === 0) {
    await dialog.showMessageBox(mainWindow, { type: 'info', buttons: ['知道了'], title: '暂无快照', message: '还没有任何稳定版快照。先在菜单选择"保存当前为稳定版快照"创建一份。' });
    return;
  }
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: [...snaps.slice(0, 3), '取消'],
    defaultId: 0,
    cancelId: snaps.slice(0, 3).length,
    title: '恢复稳定版快照',
    message: '选择要恢复的快照（将覆盖当前运行时）：',
    detail: '恢复后重启应用生效。',
  });
  if (result.response >= Math.min(snaps.length, 3)) return;
  const chosen = snaps[result.response];
  const runtimeSrc = path.join(resourcesRoot(), 'runtime');
  await dialog.showMessageBox(mainWindow, { type: 'info', buttons: ['知道了'], title: '正在恢复', message: '正在恢复，请勿关闭应用（完成后会再提示）。' });
  await fs.promises.cp(path.join(root, chosen), runtimeSrc, { recursive: true, verbatimSymlinks: true });
  await dialog.showMessageBox(mainWindow, { type: 'info', buttons: ['知道了'], title: '恢复完成', message: '快照已恢复：' + chosen + '。重启应用生效。' });
}

function setupStableSnapshotMenu() {
  const template = [
    {
      label: '工具',
      submenu: [
        { label: '保存当前为稳定版快照', click: () => { snapshotStableRuntime().catch((e) => { if (String(e.message) !== 'canceled') dialog.showErrorBox('快照失败', String(e.message)); }); } },
        { label: '恢复稳定版快照', click: () => { restoreStableRuntime().catch((e) => dialog.showErrorBox('恢复失败', String(e.message))); } },
        { type: 'separator' },
        { label: '打开备份目录', click: () => { fs.mkdirSync(stableBackupRoot(), { recursive: true }); shell.openPath(stableBackupRoot()); } },
      ],
    },
    { label: '文件', submenu: [{ role: 'quit', label: '退出' }] },
    { label: '编辑', submenu: [{ role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '视图', submenu: [{ role: 'reload', label: '重新加载' }, { role: 'forceReload', label: '强制重新加载' }, { role: 'toggleDevTools', label: '切换开发者工具' }, { type: 'separator' }, { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { type: 'separator' }, { role: 'togglefullscreen', label: '切换全屏' }] },
    { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
