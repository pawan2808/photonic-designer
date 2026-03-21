/**
 * main.js — Electron Main Process
 * 
 * Creates native window, manages embedded Python backend,
 * enforces licensing, provides system tray and native menus.
 */

const { app, BrowserWindow, dialog, ipcMain, Menu, Tray, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const log = require('electron-log');
const portfinder = require('portfinder');
const license = require('./license');
const fingerprint = require('./fingerprint');

// ─── Globals ──────────────────────────────────────────────────────────────────
let mainWindow = null;
let splashWindow = null;
let licenseWindow = null;
let tray = null;
let pythonProcess = null;
let backendPort = 5000;
let isQuitting = false;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const resourcesPath = isDev
  ? path.join(__dirname, '..')
  : process.resourcesPath;

// ─── Paths ────────────────────────────────────────────────────────────────────
function getPythonPath() {
  const platform = process.platform;
  const arch = process.arch;

  // Check if INSTALL.bat wrote a .python_path file
  const pythonPathFile = path.join(__dirname, '.python_path');
  if (fs.existsSync(pythonPathFile)) {
    const savedPath = fs.readFileSync(pythonPathFile, 'utf-8').trim();
    if (savedPath) {
      log.info(`Using saved Python path: ${savedPath}`);
      return savedPath;
    }
  }

  if (isDev) {
    // Dev mode: try multiple Python commands and common locations
    if (platform === 'win32') {
      const { execSync } = require('child_process');
      // Try 'python' first, then 'python3', then common install paths
      for (const cmd of ['python', 'python3', 'py']) {
        try {
          const result = execSync(`where ${cmd}`, { timeout: 5000, encoding: 'utf-8' });
          if (result.trim()) {
            log.info(`Found Python: ${cmd} -> ${result.trim().split('\n')[0]}`);
            return cmd;
          }
        } catch (e) { /* not found, try next */ }
      }
      // Check common paths directly
      const commonPaths = [
        'C:\\Python311\\python.exe',
        'C:\\Python310\\python.exe',
        'C:\\Python39\\python.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python310', 'python.exe'),
        path.join(process.env.USERPROFILE || '', 'anaconda3', 'python.exe'),
        path.join(process.env.USERPROFILE || '', 'miniconda3', 'python.exe'),
      ];
      for (const p of commonPaths) {
        if (fs.existsSync(p)) {
          log.info(`Found Python at: ${p}`);
          return p;
        }
      }
      return 'python'; // fallback
    } else {
      return 'python3';
    }
  }

  // Production: embedded Python
  const embedDir = path.join(resourcesPath, 'python-embed');

  if (platform === 'win32') {
    return path.join(embedDir, 'python.exe');
  } else if (platform === 'darwin') {
    return path.join(embedDir, 'bin', 'python3');
  } else {
    return path.join(embedDir, 'bin', 'python3');
  }
}

function getAppSrcPath() {
  return isDev
    ? path.join(__dirname, '..', 'src')
    : path.join(resourcesPath, 'app-src');
}

// ─── Splash Screen ───────────────────────────────────────────────────────────
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 500,
    height: 350,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!DOCTYPE html>
    <html>
    <head><style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        display: flex; align-items: center; justify-content: center;
        height: 100vh; background: transparent;
        -webkit-app-region: drag;
      }
      .card {
        background: #1a1a2e; border-radius: 20px; padding: 50px 60px;
        box-shadow: 0 25px 60px rgba(0,0,0,0.5);
        text-align: center; color: white;
        border: 1px solid rgba(255,255,255,0.08);
      }
      .logo { font-size: 48px; margin-bottom: 12px; }
      h1 { font-size: 22px; font-weight: 600; margin-bottom: 6px; letter-spacing: 0.5px; }
      .sub { color: #8888aa; font-size: 13px; margin-bottom: 30px; }
      .bar-track { width: 240px; height: 4px; background: #2a2a4a; border-radius: 2px; margin: 0 auto; overflow: hidden; }
      .bar-fill { width: 30%; height: 100%; background: linear-gradient(90deg, #4f8cff, #a855f7); border-radius: 2px; animation: load 2s ease-in-out infinite; }
      @keyframes load { 0%{width:10%;margin-left:0} 50%{width:60%;margin-left:20%} 100%{width:10%;margin-left:90%} }
      .status { color: #6666aa; font-size: 11px; margin-top: 16px; }
    </style></head>
    <body>
      <div class="card">
        <div class="logo">◈</div>
        <h1>Photonic Designer</h1>
        <div class="sub">IHP SiN Photonics PDK</div>
        <div class="bar-track"><div class="bar-fill"></div></div>
        <div class="status" id="status">Initializing...</div>
      </div>
    </body>
    </html>
  `)}`);
}

// ─── License Activation Window ───────────────────────────────────────────────
function createLicenseWindow() {
  return new Promise((resolve) => {
    licenseWindow = new BrowserWindow({
      width: 520,
      height: 480,
      frame: false,
      resizable: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js')
      }
    });

    licenseWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <!DOCTYPE html>
      <html>
      <head><style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: #1a1a2e; color: white; height: 100vh;
          display: flex; flex-direction: column;
          -webkit-app-region: drag;
        }
        .content { padding: 40px; flex: 1; -webkit-app-region: no-drag; }
        .logo { font-size: 40px; text-align: center; margin-bottom: 8px; }
        h1 { text-align: center; font-size: 20px; margin-bottom: 4px; }
        .sub { text-align: center; color: #8888aa; font-size: 12px; margin-bottom: 30px; }
        label { display: block; font-size: 12px; color: #aaa; margin-bottom: 6px; font-weight: 500; }
        input {
          width: 100%; padding: 12px 16px; background: #2a2a4a; border: 1px solid #3a3a5a;
          border-radius: 10px; color: white; font-size: 15px; font-family: monospace;
          letter-spacing: 2px; text-transform: uppercase; outline: none;
          transition: border-color 0.2s;
        }
        input:focus { border-color: #4f8cff; }
        .fp { background: #0d0d1a; padding: 10px 14px; border-radius: 8px; font-family: monospace;
               font-size: 11px; color: #6666aa; margin: 16px 0; word-break: break-all; }
        .fp-label { font-size: 10px; color: #555; margin-bottom: 4px; }
        button {
          width: 100%; padding: 14px; background: linear-gradient(135deg, #4f8cff, #a855f7);
          border: none; border-radius: 10px; color: white; font-size: 15px;
          font-weight: 600; cursor: pointer; margin-top: 20px; transition: opacity 0.2s;
        }
        button:hover { opacity: 0.9; }
        button:disabled { opacity: 0.4; cursor: not-allowed; }
        .error { color: #f44; font-size: 12px; margin-top: 10px; text-align: center; display: none; }
        .demo-link { text-align: center; margin-top: 14px; }
        .demo-link a { color: #6666aa; font-size: 12px; cursor: pointer; text-decoration: underline; }
      </style></head>
      <body>
        <div class="content">
          <div class="logo">◈</div>
          <h1>Photonic Designer</h1>
          <div class="sub">Enter your license key to activate</div>
          <label>LICENSE KEY</label>
          <input id="key" placeholder="XXXX-XXXX-XXXX-XXXX" maxlength="40" />
          <div class="fp-label">Machine Fingerprint</div>
          <div class="fp" id="fp">Loading...</div>
          <button id="btn" onclick="activate()">Activate License</button>
          <div class="error" id="err"></div>
        </div>
        <script>
          window.electronAPI.getFingerprint().then(fp => {
            document.getElementById('fp').textContent = fp;
          });
          async function activate() {
            const btn = document.getElementById('btn');
            const err = document.getElementById('err');
            const key = document.getElementById('key').value.trim();
            if (!key) { err.style.display = 'block'; err.textContent = 'Please enter a license key'; return; }
            btn.disabled = true; btn.textContent = 'Activating...';
            err.style.display = 'none';
            const result = await window.electronAPI.activateLicense(key);
            if (result.success) {
              btn.textContent = '✓ Activated!';
              setTimeout(() => window.electronAPI.licenseActivated(), 800);
            } else {
              err.style.display = 'block';
              err.textContent = result.error || 'Activation failed';
              btn.disabled = false; btn.textContent = 'Activate License';
            }
          }
          document.getElementById('key').addEventListener('keydown', e => { if (e.key === 'Enter') activate(); });
        </script>
      </body>
      </html>
    `)}`);

    // IPC handlers for license window
    ipcMain.handleOnce('license:activate', async (event, key) => {
      return await license.activate(key);
    });

    ipcMain.handleOnce('license:activated', () => {
      licenseWindow.close();
      licenseWindow = null;
      resolve(true);
    });

    ipcMain.handleOnce('license:fingerprint', async () => {
      return await fingerprint.getDisplayFingerprint();
    });

    licenseWindow.on('closed', () => {
      if (!license.isValid) {
        resolve(false);
      }
    });
  });
}

// ─── Main Application Window ─────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1024,
    minHeight: 700,
    title: 'Photonic Designer',
    show: false,
    backgroundColor: '#1a1a2e',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Build native menu
  const menuTemplate = [
    {
      label: 'File',
      submenu: [
        { label: 'New Design', accelerator: 'CmdOrCtrl+N', click: () => mainWindow.webContents.send('menu:new') },
        { label: 'Open Design...', accelerator: 'CmdOrCtrl+O', click: () => openDesign() },
        { label: 'Save Design', accelerator: 'CmdOrCtrl+S', click: () => mainWindow.webContents.send('menu:save') },
        { label: 'Save As...', accelerator: 'CmdOrCtrl+Shift+S', click: () => saveDesignAs() },
        { type: 'separator' },
        { label: 'Export GDS', accelerator: 'CmdOrCtrl+E', click: () => mainWindow.webContents.send('menu:export-gds') },
        { label: 'Open in KLayout', accelerator: 'CmdOrCtrl+K', click: () => mainWindow.webContents.send('menu:open-klayout') },
        { type: 'separator' },
        { label: 'Settings...', accelerator: 'CmdOrCtrl+,', click: () => mainWindow.webContents.send('menu:settings') },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => mainWindow.webContents.send('menu:undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => mainWindow.webContents.send('menu:redo') },
        { type: 'separator' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => mainWindow.webContents.send('menu:select-all') },
        { label: 'Delete Selected', accelerator: 'Delete', click: () => mainWindow.webContents.send('menu:delete') },
        { type: 'separator' },
        { label: 'Copy Component', accelerator: 'CmdOrCtrl+C', click: () => mainWindow.webContents.send('menu:copy') },
        { label: 'Paste Component', accelerator: 'CmdOrCtrl+V', click: () => mainWindow.webContents.send('menu:paste') },
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => mainWindow.webContents.send('menu:zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => mainWindow.webContents.send('menu:zoom-out') },
        { label: 'Fit to Window', accelerator: 'CmdOrCtrl+0', click: () => mainWindow.webContents.send('menu:fit') },
        { type: 'separator' },
        { label: 'Toggle Grid', accelerator: 'G', click: () => mainWindow.webContents.send('menu:toggle-grid') },
        { label: 'Toggle Layers Panel', accelerator: 'L', click: () => mainWindow.webContents.send('menu:toggle-layers') },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'About Photonic Designer', click: () => showAbout() },
        { label: 'License Info', click: () => showLicenseInfo() },
        { label: 'Deactivate License', click: () => deactivateLicense() },
        { type: 'separator' },
        { label: 'Nazca Documentation', click: () => shell.openExternal('https://nazca-design.org/manual/') },
        { label: 'IHP PDK Docs', click: () => shell.openExternal('https://www.2-2.se/en/support/ihp-sin/') },
      ]
    }
  ];

  // macOS app menu
  if (process.platform === 'darwin') {
    menuTemplate.unshift({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  // Load the app — points to the React frontend served by Flask
  mainWindow.loadURL(`http://localhost:${backendPort}`);

  mainWindow.once('ready-to-show', () => {
    if (splashWindow) {
      splashWindow.close();
      splashWindow = null;
    }
    mainWindow.show();
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── Python Backend ──────────────────────────────────────────────────────────
async function startPythonBackend() {
  return new Promise(async (resolve, reject) => {
    try {
      // Find a free port
      backendPort = await portfinder.getPortPromise({ port: 5000 });

      const pythonPath = getPythonPath();
      const appPath = path.join(getAppSrcPath(), 'app.py');

      // Set environment
      const env = {
        ...process.env,
        FLASK_PORT: String(backendPort),
        FLASK_ENV: 'production',
        PYTHONDONTWRITEBYTECODE: '1',
        // Add PDK to Python path
        PYTHONPATH: [
          path.join(resourcesPath, 'pdk', 'IHP_PDK_Nazca_PreDev_V02'),
          process.env.PYTHONPATH || ''
        ].filter(Boolean).join(path.delimiter)
      };

      log.info(`Starting Python: ${pythonPath} ${appPath} on port ${backendPort}`);

      pythonProcess = spawn(pythonPath, [appPath], {
        env,
        cwd: getAppSrcPath(),
        stdio: ['pipe', 'pipe', 'pipe'],
        // Hide console window on Windows
        windowsHide: true
      });

      let started = false;

      pythonProcess.stdout.on('data', (data) => {
        const output = data.toString();
        log.info('[Python]', output.trim());
        if (!started && (output.includes('Running on') || output.includes('http://localhost') || output.includes('http://127.0.0.1'))) {
          started = true;
          // Give Flask a moment to fully start
          setTimeout(() => resolve(backendPort), 500);
        }
      });

      pythonProcess.stderr.on('data', (data) => {
        const output = data.toString();
        log.info('[Python:err]', output.trim());
        // Flask outputs startup info on stderr
        if (!started && (output.includes('Running on') || output.includes('http://localhost') || output.includes('http://127.0.0.1'))) {
          started = true;
          setTimeout(() => resolve(backendPort), 500);
        }
      });

      pythonProcess.on('error', (err) => {
        log.error('Python process error:', err);
        reject(err);
      });

      pythonProcess.on('exit', (code) => {
        log.info(`Python process exited with code ${code}`);
        if (!started) reject(new Error(`Python exited with code ${code}`));
      });

      // Timeout
      setTimeout(() => {
        if (!started) {
          started = true;
          // Try connecting anyway — maybe output was different
          resolve(backendPort);
        }
      }, 15000);

    } catch (err) {
      reject(err);
    }
  });
}

function stopPythonBackend() {
  if (pythonProcess) {
    log.info('Stopping Python backend...');
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pythonProcess.pid), '/f', '/t']);
    } else {
      pythonProcess.kill('SIGTERM');
      setTimeout(() => {
        try { pythonProcess.kill('SIGKILL'); } catch (e) {}
      }, 3000);
    }
    pythonProcess = null;
  }
}

// ─── Helper Functions ────────────────────────────────────────────────────────
async function showAbout() {
  const fp = await fingerprint.getDisplayFingerprint();
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'About Photonic Designer',
    message: 'Photonic Designer v1.0.0',
    detail: `IHP SiN Photonics PDK Layout Tool\n\nPowered by Nazca Design + Electron\nMachine: ${fp}\n\n© 2026 Photonic Designer`
  });
}

async function showLicenseInfo() {
  const stored = license.getStoredLicense();
  const fp = await fingerprint.getDisplayFingerprint();
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'License Information',
    message: 'License Status',
    detail: stored
      ? `Key: ${stored.key}\nStatus: ${stored.status || 'Active'}\nExpiry: ${stored.expiry || 'Perpetual'}\nMachine: ${fp}`
      : `No license activated\nMachine: ${fp}`
  });
}

async function deactivateLicense() {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Deactivate License',
    message: 'Are you sure you want to deactivate your license on this machine?',
    detail: 'You can reactivate on another machine after deactivation.',
    buttons: ['Cancel', 'Deactivate'],
    defaultId: 0,
    cancelId: 0
  });
  if (result.response === 1) {
    await license.deactivate();
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Deactivated',
      message: 'License deactivated. The app will close now.'
    });
    isQuitting = true;
    app.quit();
  }
}

async function openDesign() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Design',
    filters: [
      { name: 'Photonic Design', extensions: ['phd', 'json'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (!result.canceled && result.filePaths.length > 0) {
    mainWindow.webContents.send('menu:open-file', result.filePaths[0]);
  }
}

async function saveDesignAs() {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Design As',
    defaultPath: 'design.phd',
    filters: [
      { name: 'Photonic Design', extensions: ['phd'] },
      { name: 'JSON', extensions: ['json'] }
    ]
  });
  if (!result.canceled) {
    mainWindow.webContents.send('menu:save-as', result.filePath);
  }
}

// ─── System Tray ─────────────────────────────────────────────────────────────
function createTray() {
  // In production you'd use a real icon file
  // tray = new Tray(path.join(resourcesPath, 'resources', 'tray-icon.png'));
  // For now, skip tray on macOS (app lives in dock)
  if (process.platform === 'darwin') return;

  try {
    const trayMenu = Menu.buildFromTemplate([
      { label: 'Show Photonic Designer', click: () => mainWindow?.show() },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
    ]);
    // tray.setContextMenu(trayMenu);
    // tray.setToolTip('Photonic Designer');
    // tray.on('click', () => mainWindow?.show());
  } catch (e) {
    log.warn('Tray creation skipped:', e.message);
  }
}

// ─── App Lifecycle ───────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  log.info('App starting...');

  // 1. Show splash
  createSplashWindow();

  // 2. Initialize license system
  const licResult = await license.init(resourcesPath);

  // 3. License enforcement
  if (!licResult.valid && licResult.needsActivation) {
    if (splashWindow) { splashWindow.close(); splashWindow = null; }
    const activated = await createLicenseWindow();
    if (!activated) {
      app.quit();
      return;
    }
    createSplashWindow(); // Re-show splash for backend startup
  }

  // Set up license revocation callback
  license.onInvalidated = (reason) => {
    dialog.showMessageBoxSync(mainWindow || splashWindow, {
      type: 'error',
      title: 'License Invalid',
      message: 'Your license is no longer valid',
      detail: reason + '\n\nThe application will close.'
    });
    isQuitting = true;
    app.quit();
  };

  // 4. Start Python backend
  try {
    await startPythonBackend();
    log.info(`Backend running on port ${backendPort}`);
  } catch (err) {
    log.error('Failed to start backend:', err);
    if (splashWindow) { splashWindow.close(); splashWindow = null; }
    dialog.showErrorBox(
      'Startup Error',
      `Could not start the Python backend.\n\n${err.message}\n\nMake sure Python dependencies are installed.`
    );
    app.quit();
    return;
  }

  // 5. Create main window
  createMainWindow();
  createTray();

  app.on('activate', () => {
    if (mainWindow) {
      mainWindow.show();
    } else {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    isQuitting = true;
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  stopPythonBackend();
});

// Single instance lock — prevent running multiple copies
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
