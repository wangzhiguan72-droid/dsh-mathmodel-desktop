'use strict';

// This isolated bridge also owns the desktop release badge. It does not patch
// the upstream GUI bundle or expose local files to the host page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  onStatus: (callback) => {
    ipcRenderer.on('desktop:status', (_event, text) => callback(text));
  },
  onError: (callback) => {
    ipcRenderer.on('desktop:error', (_event, payload) => callback(payload));
  },
  retry: () => ipcRenderer.send('desktop:retry'),
  revealLog: () => ipcRenderer.send('desktop:reveal-log'),
  quit: () => ipcRenderer.send('desktop:quit'),
});

window.addEventListener('DOMContentLoaded', () => {
  if (!/^https?:$/.test(location.protocol) || !['127.0.0.1', 'localhost'].includes(location.hostname)) return;
  const badge = document.createElement('div');
  badge.id = 'dsh-desktop-update';
  badge.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483646';
  const shadow = badge.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = 'button{font:12px system-ui;padding:7px 11px;border:1px solid #526079;border-radius:8px;background:#172235;color:#c5d0e2;cursor:pointer;box-shadow:0 2px 8px #0005}button[data-highlight=true]{background:#f4c35c;color:#172235;border-color:#ffd984;font-weight:650}button:focus-visible{outline:2px solid #fff;outline-offset:3px}button:disabled{cursor:progress;opacity:.8}';
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', '桌面更新');
  button.addEventListener('click', () => { void ipcRenderer.invoke('desktop:update-open'); });
  shadow.append(style, button);
  let state;
  function render(value) {
    if (!value) return;
    state = value;
    const highlight = ['available', 'ready'].includes(value.phase);
    button.dataset.highlight = String(highlight);
    button.disabled = ['checking', 'downloading', 'installing'].includes(value.phase);
    button.textContent = value.phase === 'checking' ? '检查更新…'
      : value.phase === 'downloading' ? '正在准备更新…'
        : value.phase === 'installing' ? '正在重启…'
          : highlight ? (value.phase === 'ready' ? '安装更新 · ' : '桌面更新 · ') + value.availableVersion
            : '桌面版 ' + value.currentVersion;
    button.title = value.detail || '点击检查桌面更新';
    badge.dataset.phase = value.phase;
  }
  document.body.append(badge);
  new MutationObserver(() => { if (!badge.isConnected) { document.body.append(badge); render(state); } })
    .observe(document.body, { childList: true });
  ipcRenderer.on('desktop:update-status', (_event, value) => render(value));
  void ipcRenderer.invoke('desktop:update-state').then(render);
});
