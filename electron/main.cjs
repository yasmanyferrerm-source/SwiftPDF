// SwiftPDF - Electron main process (Windows desktop app)
// Every PDF gets its own window. Each window is an independent copy of the app.
const { app, BrowserWindow, dialog, ipcMain, protocol, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const DIST = path.join(__dirname, '..', 'dist');
const DEV_URL = process.env.VITE_DEV_SERVER_URL;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.icc': 'application/octet-stream',
};

/** webContents.id -> { win, dirty, hasDoc, pending: file|null } */
const windows = new Map();

function pdfArgs(argv) {
  return argv.slice(1).filter((a) => a && a.toLowerCase().endsWith('.pdf') && fs.existsSync(a));
}

async function readPdf(filePath) {
  const data = await fs.promises.readFile(filePath);
  return { path: filePath, name: path.basename(filePath), data: new Uint8Array(data) };
}

const infoFor = (sender) => windows.get(sender.id);

/** Opens `file` ({path} or {name,data}) in a window with no document, or a new window. */
function openInWindow(file) {
  const empty = [...windows.values()].find((w) => !w.hasDoc && !w.pending && !w.win.isDestroyed());
  if (empty && empty.ready) {
    deliver(empty, file);
    if (empty.win.isMinimized()) empty.win.restore();
    empty.win.focus();
    return;
  }
  createWindow(file);
}

async function deliver(info, file) {
  try {
    const payload = file.data ? file : await readPdf(file.path);
    info.hasDoc = true;
    info.win.webContents.send('open-file', payload);
  } catch (err) {
    dialog.showErrorBox('SwiftPDF', `Could not open ${file.path || file.name}\n${err.message}`);
  }
}

function createWindow(pendingFile = null) {
  const focused = BrowserWindow.getFocusedWindow();
  const opts = {
    width: 1280,
    height: 860,
    minWidth: 420,
    minHeight: 500,
    title: 'SwiftPDF',
    backgroundColor: '#1f2328',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (focused && !focused.isMaximized() && !focused.isFullScreen()) {
    const [x, y] = focused.getPosition();
    const [w, h] = focused.getSize();
    Object.assign(opts, { x: x + 32, y: y + 32, width: w, height: h });
  }
  const win = new BrowserWindow(opts);
  const id = win.webContents.id;
  const info = { win, dirty: false, hasDoc: !!pendingFile, pending: pendingFile, ready: false };
  windows.set(id, info);

  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') {
      win.webContents.toggleDevTools();
    }
  });
  win.webContents.on('did-finish-load', () => { info.ready = true; });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', (e) => {
    if (!info.dirty) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Discard changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: `You have unsaved changes in "${win.getTitle().replace(/^• /, '').replace(/ — SwiftPDF$/, '')}". Close it anyway?`,
    });
    if (choice === 1) e.preventDefault();
  });
  win.on('closed', () => windows.delete(id));

  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadURL('app://local/index.html');
  return win;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Double-clicking another PDF (or "Open with") while SwiftPDF is running.
  app.on('second-instance', (_e, argv) => {
    const files = pdfArgs(argv);
    if (files.length) files.forEach((f) => openInWindow({ path: f }));
    else createWindow();
  });
}

Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const filePath = path.normalize(path.join(DIST, rel));
    if (!filePath.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
    try {
      const data = await fs.promises.readFile(filePath);
      const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      return new Response(data, { headers: { 'content-type': type } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  ipcMain.handle('open-dialog', async (e) => {
    const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
      title: 'Open PDF',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
    });
    if (res.canceled || !res.filePaths.length) return [];
    return res.filePaths;
  });

  ipcMain.handle('read-file', async (_e, filePath) => readPdf(filePath));

  // Open a file in another window: {path} or {name, data}
  ipcMain.handle('open-in-new-window', async (_e, file) => {
    createWindow(file && (file.path || file.data) ? file : null);
  });
  ipcMain.handle('new-window', async () => { createWindow(); });

  ipcMain.handle('save-file', async (_e, filePath, data) => {
    await fs.promises.writeFile(filePath, Buffer.from(data));
    return filePath;
  });

  ipcMain.handle('save-dialog', async (e, defaultName, data) => {
    const res = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
      title: 'Save PDF',
      defaultPath: defaultName || 'document.pdf',
      filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
    });
    if (res.canceled || !res.filePath) return null;
    let target = res.filePath;
    if (!target.toLowerCase().endsWith('.pdf')) target += '.pdf';
    await fs.promises.writeFile(target, Buffer.from(data));
    return target;
  });

  ipcMain.handle('get-pending-file', async (e) => {
    const info = infoFor(e.sender);
    if (!info || !info.pending) return null;
    const f = info.pending;
    info.pending = null;
    try { return f.data ? f : await readPdf(f.path); } catch { info.hasDoc = false; return null; }
  });

  // Shows the Windows print dialog for this window's print view.
  ipcMain.handle('print', (e, jobName) => new Promise((resolve) => {
    const wc = e.sender;
    wc.print({ silent: false, printBackground: true, margins: { marginType: 'none' }, header: '', footer: '' },
      (success, reason) => resolve({ success, reason: reason || '' }));
  }));

  ipcMain.on('set-dirty', (e, value) => { const i = infoFor(e.sender); if (i) i.dirty = !!value; });
  ipcMain.on('set-has-doc', (e, value) => { const i = infoFor(e.sender); if (i) i.hasDoc = !!value; });
  ipcMain.on('set-title', (e, title) => { const i = infoFor(e.sender); if (i && !i.win.isDestroyed()) i.win.setTitle(title); });

  const files = pdfArgs(process.argv);
  if (files.length) files.forEach((f) => createWindow({ path: f }));
  else createWindow();
});

app.on('window-all-closed', () => app.quit());
