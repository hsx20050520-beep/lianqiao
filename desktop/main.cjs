const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, session, shell } = require('electron');
const path = require('node:path');

const siteUrl = 'https://lianqiao-assist-2xoqymkdrbe.qoder.zone';
let mainWindow;
let nut;
let controlQueue = Promise.resolve();

async function getNut() {
  if (!nut) nut = await import('@nut-tree/nut-js');
  return nut;
}

function keyMap(lib) {
  return {
    Escape: lib.Key.Escape,
    Backspace: lib.Key.Backspace,
    Tab: lib.Key.Tab,
    Enter: lib.Key.Enter,
    Return: lib.Key.Return,
    Delete: lib.Key.Delete,
    Insert: lib.Key.Insert,
    Home: lib.Key.Home,
    End: lib.Key.End,
    PageUp: lib.Key.PageUp,
    PageDown: lib.Key.PageDown,
    ArrowUp: lib.Key.Up,
    ArrowDown: lib.Key.Down,
    ArrowLeft: lib.Key.Left,
    ArrowRight: lib.Key.Right,
    Shift: lib.Key.LeftShift,
    Control: lib.Key.LeftControl,
    Alt: lib.Key.LeftAlt,
    Meta: lib.Key.LeftSuper,
    ' ': lib.Key.Space,
    F1: lib.Key.F1,
    F2: lib.Key.F2,
    F3: lib.Key.F3,
    F4: lib.Key.F4,
    F5: lib.Key.F5,
    F6: lib.Key.F6,
    F7: lib.Key.F7,
    F8: lib.Key.F8,
    F9: lib.Key.F9,
    F10: lib.Key.F10,
    F11: lib.Key.F11,
    F12: lib.Key.F12,
  };
}

async function applyControl(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const lib = await getNut();
  const display = screen.getPrimaryDisplay();
  const bounds = display.bounds;

  if (payload.action === 'mousemove') {
    const x = Math.max(0, Math.min(1, Number(payload.x) || 0));
    const y = Math.max(0, Math.min(1, Number(payload.y) || 0));
    await lib.mouse.setPosition({ x: Math.round(bounds.x + x * bounds.width), y: Math.round(bounds.y + y * bounds.height) });
    return true;
  }

  if (payload.action === 'click') {
    const button = [0, 1, 2].includes(Number(payload.button)) ? Number(payload.button) : 0;
    await lib.mouse.click([lib.Button.LEFT, lib.Button.MIDDLE, lib.Button.RIGHT][button]);
    return true;
  }

  if (payload.action === 'wheel') {
    const delta = Math.max(-1000, Math.min(1000, Number(payload.delta) || 0));
    const amount = Math.max(1, Math.min(20, Math.round(Math.abs(delta) / 120)));
    if (delta > 0) await lib.mouse.scrollDown(amount);
    else if (delta < 0) await lib.mouse.scrollUp(amount);
    return true;
  }

  if (payload.action === 'key' && typeof payload.key === 'string') {
    const modifiers = payload.modifiers || {};
    const special = keyMap(lib);
    const modifierKeys = [];
    if (modifiers.ctrl) modifierKeys.push(lib.Key.LeftControl);
    if (modifiers.alt) modifierKeys.push(lib.Key.LeftAlt);
    if (modifiers.shift) modifierKeys.push(lib.Key.LeftShift);
    if (modifiers.meta) modifierKeys.push(lib.Key.LeftSuper);

    if (payload.key.length === 1 && !modifierKeys.length) {
      if (payload.down !== false) await lib.keyboard.type(payload.key);
      return true;
    }

    const upper = payload.key.toUpperCase();
    const key = special[payload.key] || (/^[A-Z]$/.test(upper) ? lib.Key[upper] : null);
    if (!key && key !== 0) return false;
    if (payload.down !== false) await lib.keyboard.pressKey(...modifierKeys, key);
    else await lib.keyboard.releaseKey(...modifierKeys, key);
    return true;
  }

  return false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: '连桥',
    autoHideMenuBar: true,
    backgroundColor: '#090d12',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(siteUrl);
}

app.whenReady().then(() => {
  ipcMain.handle('lianqiao:apply-control', (_event, payload) => {
    controlQueue = controlQueue.then(() => applyControl(payload)).catch(() => false);
    return controlQueue;
  });

  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => callback(sources.length ? { video: sources[0] } : null))
      .catch(() => callback(null));
  });

  globalShortcut.register('Ctrl+Alt+Shift+L', () => {
    mainWindow?.webContents.send('lianqiao:emergency-stop');
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
