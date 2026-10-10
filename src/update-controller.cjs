'use strict';

const fs = require('node:fs');
const path = require('node:path');
const updates = require('./desktop-updates.cjs');
const defaults = require('./update-channel.json');

function validateFeedUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('更新地址无效');
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('更新地址必须使用 HTTPS，且不能包含密码或片段');
  }
  return url.href;
}

function createUpdateController({ app, dialog, ipcMain, BrowserWindow, getWindow, getNodeBin, getHomeDir, log,
  core = updates, settingsDefaults = defaults }) {
  let state = { phase: 'idle', currentVersion: app.getVersion(), detail: '' };
  let release = null, prepared = null, busy = false, settingsWindow = null;
  const settingsPath = path.join(app.getPath('userData'), 'desktop-update-settings.json');
  let settings = { ...settingsDefaults }, settingsError = null;
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.feedUrl = validateFeedUrl(saved.feedUrl);
    settings.autoCheck = saved.autoCheck !== false;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      settingsError = new Error('已保存的更新设置无效，请在更新设置中重新保存：' + error.message);
      settings = { ...settingsDefaults, feedUrl: '', autoCheck: false };
      state = { ...state, phase: 'error', detail: settingsError.message };
    }
  }

  function publish(change) {
    state = { ...state, ...change };
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('desktop:update-status', state);
  }

  function trusted(event, window = getWindow()) {
    return window && !window.isDestroyed() && event.sender === window.webContents
      && (!event.senderFrame || event.senderFrame === window.webContents.mainFrame);
  }

  function identity() {
    return { installDir: path.dirname(app.getPath('exe')), executableName: path.basename(app.getPath('exe')),
      packageName: require('../package.json').name, appId: settingsDefaults.appId,
      userDataDir: app.getPath('userData'), homeDir: getHomeDir?.(), currentVersion: app.getVersion() };
  }

  async function check(manual = false) {
    if (busy) return state;
    if (prepared) { publish({ phase: 'ready', availableVersion: prepared.toVersion }); return state; }
    if (process.platform !== 'win32' || !app.isPackaged) {
      publish({ phase: 'unsupported', detail: '应用内更新在 Windows 安装版中可用。' });
      return state;
    }
    busy = true;
    release = null;
    publish({ phase: 'checking', detail: '正在检查桌面发行版…' });
    try {
      if (settingsError) throw settingsError;
      const result = await core.checkForUpdate({ feedUrl: settings.feedUrl,
        currentVersion: app.getVersion(), appId: settingsDefaults.appId });
      release = result.available ? result.release : null;
      publish({ phase: release ? 'available' : 'current', availableVersion: release?.version,
        detail: release ? '发现新版本，点击查看并选择是否更新。' : '当前已是此更新渠道的最新版本。' });
      if (manual && !release) await dialog.showMessageBox(getWindow(), {
        type: 'info', title: '桌面更新', message: state.detail, buttons: ['知道了'] });
    } catch (error) {
      publish({ phase: 'error', availableVersion: undefined,
        detail: error.statusCode === 404 ? '更新源尚未提供更新清单，当前版本可以继续使用。'
          : '暂时无法检查更新：' + error.message });
      log('[desktop] update check: ' + error.message);
      if (manual) await dialog.showMessageBox(getWindow(), {
        type: 'info', title: '桌面更新', message: state.detail,
        detail: '更新源：' + settings.feedUrl + '\n当前版本可继续使用。', buttons: ['知道了'] });
    } finally { busy = false; }
    return state;
  }

  async function install(job) {
    const rollingBackData = job.kind === 'rollback' && Boolean(job.restoreDataSnapshot);
    const answer = await dialog.showMessageBox(getWindow(), { type: 'question', title: '安装桌面更新',
      message: rollingBackData ? `恢复 ${job.toVersion} 及升级前的数据吗？`
        : `现在切换到 ${job.toVersion} 并重启应用吗？`,
      detail: rollingBackData
        ? '会话格式已改变。恢复旧版时，会把会话和配置恢复到升级前；升级后产生的数据将另存备份，不会在旧版中显示。应用随后重启。'
        : '应用会关闭并重新启动。新版无法正常启动时，将恢复此前版本。个人配置和项目保留。',
      buttons: [rollingBackData ? '备份当前数据并恢复' : '安装并重启', '稍后'], defaultId: 1, cancelId: 1 });
    if (answer.response !== 0) return;
    publish({ phase: 'installing', detail: '正在准备安全重启…' });
    await core.launchUpdate(job, { nodeBin: getNodeBin(), currentPid: process.pid });
    app.quit();
  }

  async function open() {
    if (busy) return;
    if (!release && !prepared) await check(true);
    if (!release && !prepared) return;
    busy = true;
    try {
      if (!prepared) {
        const answer = await dialog.showMessageBox(getWindow(), { type: 'question', title: '发现桌面更新',
          message: `${app.getVersion()} → ${release.version}`,
          detail: (release.notes || '此发行版未附更新说明。') + '\n\n更新源：' + settings.feedUrl
            + '\n确认后才会下载，下载完成后可选择安装时间。',
          buttons: ['下载更新', '稍后'], defaultId: 1, cancelId: 1 });
        if (answer.response !== 0) return;
        publish({ phase: 'downloading', detail: '正在下载、校验并准备更新…' });
        prepared = await core.prepareUpdate({ ...identity(), release, nodeBin: getNodeBin(), onProgress: progress => {
          const percent = progress.total ? Math.floor(progress.bytes / progress.total * 100) : null;
          publish({ detail: progress.phase === 'download' ? `正在下载更新${percent === null ? '' : '：' + percent + '%'}…`
            : progress.phase === 'extract' ? '下载已校验，正在解压完整应用…' : '正在校验更新…', progress: percent });
        } });
        publish({ phase: 'ready', availableVersion: prepared.toVersion, detail: '更新已校验，点击选择安装时间。' });
      }
      await install(prepared);
    } catch (error) {
      if (state.phase === 'installing') prepared = null;
      publish({ phase: prepared ? 'ready' : 'available', detail: '更新未完成：' + error.message });
      log('[desktop] update failed: ' + error.message);
      await dialog.showMessageBox(getWindow(), { type: 'error', title: '更新未完成',
        message: error.message, detail: '当前应用仍可继续使用。', buttons: ['知道了'] });
    } finally { busy = false; }
  }

  async function rollback() {
    if (busy) return;
    busy = true;
    try {
      const job = await core.prepareRollback({ ...identity(), nodeBin: getNodeBin() });
      if (!job) {
        await dialog.showMessageBox(getWindow(), { type: 'info', title: '恢复上一个版本',
          message: '还没有经本应用更新并验证成功的上一版。', buttons: ['知道了'] });
        return;
      }
      await install(job);
    } catch (error) {
      await dialog.showMessageBox(getWindow(), { type: 'error', title: '无法恢复上一版',
        message: error.message, buttons: ['知道了'] });
    } finally { busy = false; }
  }

  function showSettings() {
    if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.focus(); return; }
    settingsWindow = new BrowserWindow({ parent: getWindow(), width: 660, height: 380, resizable: false,
      title: '桌面更新设置', webPreferences: { preload: path.join(__dirname, 'update-settings-preload.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true } });
    settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    settingsWindow.webContents.on('will-navigate', event => event.preventDefault());
    settingsWindow.on('closed', () => { settingsWindow = null; });
    void settingsWindow.loadFile(path.join(__dirname, 'update-settings.html'));
  }

  ipcMain.handle('desktop:update-state', event => trusted(event) ? state : null);
  ipcMain.handle('desktop:update-open', event => trusted(event) ? open() : undefined);
  ipcMain.handle('desktop:update-settings-get', event => trusted(event, settingsWindow) ? settings : null);
  ipcMain.handle('desktop:update-settings-save', async (event, value) => {
    if (!trusted(event, settingsWindow)) throw new Error('Invalid update settings window');
    if (busy) throw new Error('请等待当前更新操作完成后修改渠道。');
    const next = { appId: settingsDefaults.appId, feedUrl: validateFeedUrl(value?.feedUrl), autoCheck: value?.autoCheck !== false };
    const temporary = settingsPath + '.' + process.pid + '.tmp';
    await fs.promises.writeFile(temporary, JSON.stringify(next, null, 2), { flag: 'wx' });
    await fs.promises.rename(temporary, settingsPath);
    settings = next; settingsError = null; release = null; prepared = null;
    publish({ phase: 'idle', availableVersion: undefined, detail: '' });
    return settings;
  });

  return { check, open, rollback, showSettings, getState: () => state, async start() {
    let last;
    try { last = core.readLastUpdate({ userDataDir: app.getPath('userData') }); }
    catch (error) {
      publish({ phase: 'error', detail: '更新记录无法读取：' + error.message });
      log('[desktop] update record: ' + error.message);
      return;
    }
    const noticePath = path.join(app.getPath('userData'), 'desktop-update-notice.json');
    let noticed;
    try { noticed = JSON.parse(fs.readFileSync(noticePath, 'utf8')).nonce; } catch { /* First notice. */ }
    if (last?.state === 'rolled-back' && last.nonce !== noticed) {
      publish({ detail: '上次更新启动失败，已恢复此前版本。' });
      if (!(process.env.DSH_DESKTOP_VERIFY === '1' && process.env.DSH_DESKTOP_HEADLESS === '1')) {
        await dialog.showMessageBox(getWindow(), { type: 'warning', title: '已恢复此前版本',
          message: '上次更新未能正常启动，应用已恢复此前版本。', detail: last.error || '', buttons: ['知道了'] });
      }
      await fs.promises.writeFile(noticePath, JSON.stringify({ nonce: last.nonce }));
    }
    if (settings.autoCheck) void check();
  } };
}

module.exports = { createUpdateController, validateFeedUrl };
