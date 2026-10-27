// SwiftPDF - Electron main process (Windows desktop app)
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

let win = null;
let dirty = false;
let pendingFile = findPdfArg(process.argv);

function findPdfArg(argv) {
  return argv.slice(1).find((a) => a && a.toLowerCase().endsWith('.pdf') && fs.existsSync(a)) || null;
}

async function readPdf(filePath) {
  const data = await fs.promises.readFile(filePath);
  return { path: filePath, name: path.basename(filePath), data: new Uint8Array(data) };
}

async function sendFileToWindow(filePath) {
  if (!win) return;
  try {
    win.webContents.send('open-file', await readPdf(filePath));
  } catch (err) {
    dialog.showErrorBox('SwiftPDF', `Could not open ${filePath}\n${err.message}`);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const file = findPdfArg(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (file) sendFileToWindow(file);
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
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
  });

  Menu.setApplicationMenu(null);
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') {
      win.webContents.toggleDevTools();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', (e) => {
    if (!dirty) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Discard changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: 'You have unsaved changes. Close SwiftPDF anyway?',
    });
    if (choice === 1) e.preventDefault();
  });
  win.on('closed', () => { win = null; });

  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadURL('app://local/index.html');
}

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

  ipcMain.handle('open-dialog', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Open PDF',
      properties: ['openFile'],
      filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return readPdf(res.filePaths[0]);
  });

  ipcMain.handle('read-file', async (_e, filePath) => readPdf(filePath));

  ipcMain.handle('save-file', async (_e, filePath, data) => {
    await fs.promises.writeFile(filePath, Buffer.from(data));
    return filePath;
  });

  ipcMain.handle('save-dialog', async (_e, defaultName, data) => {
    const res = await dialog.showSaveDialog(win, {
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

  ipcMain.handle('get-pending-file', async () => {
    if (!pendingFile) return null;
    const f = pendingFile;
    pendingFile = null;
    try { return await readPdf(f); } catch { return null; }
  });

  ipcMain.on('set-dirty', (_e, value) => { dirty = !!value; });
  ipcMain.on('set-title', (_e, title) => { if (win) win.setTitle(title); });

  createWindow();
});

app.on('window-all-closed', () => app.quit());
