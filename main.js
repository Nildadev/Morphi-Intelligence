const { app, BrowserWindow, dialog, globalShortcut, ipcMain, nativeTheme, safeStorage, shell, systemPreferences } = require('electron');
const path = require('node:path');
const { startBackend } = require('./main/backend');
const { createCredentialStore } = require('./main/credentials');
const { assertTrustedSender, registerIpc } = require('./main/ipc');

const RESTART_DELAYS_MS = [1000, 3000, 8000];
const STARTUP_ERROR_TITLE = 'Không thể khởi động server';

let mainWindow = null;
let backend = null;
let serverPort = null;
let restartCount = 0;
let restartTimer = null;
let shuttingDown = false;
let startupFailed = false;
let pushCredentials = () => false;
/** The effective app theme, pushed by the renderer (`morphi:theme`) and defaulted from the OS. */
let lastTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';

/** Titlebar overlay chrome per theme — matches the sidebar tone of each theme (#171717 dark,
 *  #f9f9f9 light) so the native caption buttons sit on the same surface as the strip. */
const TITLEBAR_THEMES = {
    dark: { color: '#171717', symbolColor: '#e5e5e5' },
    light: { color: '#f9f9f9', symbolColor: '#1a1a1a' },
};

/** Windows/macOS expose the user's accent as bare RRGGBB hex; normalise to #rrggbb. */
function normalizeAccent(raw) {
    const hex = String(raw || '').replace(/^#/, '').slice(0, 6).toLowerCase();
    return /^[0-9a-f]{6}$/.test(hex) ? `#${hex}` : null;
}

/** Blend two #rrggbb colours: `t` of the second over the first. */
function mixHex(hexA, hexB, t) {
    const parts = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const a = parts(hexA);
    const b = parts(hexB);
    const mixed = a.map((value, i) => Math.round(value + (b[i] - value) * t));
    return '#' + mixed.map((value) => value.toString(16).padStart(2, '0')).join('');
}

function syncTitlebarChrome(theme) {
    if (!mainWindow) return;
    lastTheme = theme === 'dark' ? 'dark' : 'light';
    const colors = TITLEBAR_THEMES[lastTheme];
    // The caption area follows the same faint accent haze the shell paints.
    const accent = normalizeAccent(systemPreferences.getAccentColor());
    const tinted = accent ? mixHex(colors.color, accent, 0.08) : colors.color;
    mainWindow.setTitleBarOverlay({ color: tinted, symbolColor: colors.symbolColor, height: 40 });
    mainWindow.setBackgroundColor(tinted);
}

function pushSystemAccent() {
    if (!mainWindow) return;
    mainWindow.webContents.send('morphi:accent', {
        accent: normalizeAccent(systemPreferences.getAccentColor()),
        dark: nativeTheme.shouldUseDarkColors,
    });
}

// Fix for "Unable to create cache" and "Access is denied"
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-gpu-cache');

function focusMainWindow() {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

function loadServerUrl() {
    if (!mainWindow || serverPort === null) return;
    mainWindow.loadURL(`http://127.0.0.1:${serverPort}`).catch((error) => {
        console.error('[main] Failed to load UI:', error.message);
    });
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 800,
        // Keep the rail + docked sidebar + chat column from collapsing into one another: at
        // smaller widths the chat would touch the window edge and the sidebar would overlay it.
        minWidth: 1024,
        minHeight: 700,
        title: "Morphi Intelligence",
        // Hidden native titlebar merged into the app's own strip (AppShell): the OS caption buttons
        // are drawn by titleBarOverlay over the strip's top-right (40px tall, matching h-10), and
        // the strip is the drag region. Colours match the dark sidebar tone (#171717).
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#171717', symbolColor: '#e5e5e5', height: 40 },
        icon: path.join(__dirname, 'logo.png'),
        backgroundColor: '#171717',
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    mainWindow = win;
    win.setMenu(null);
    // Pre-paint default (OS theme); the renderer re-syncs to the app theme on mount via
    // `morphi:theme`, and pulls the accent on mount via `morphi:accent` (the event push covers
    // later OS-side changes).
    syncTitlebarChrome(nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
    win.webContents.on('did-finish-load', pushSystemAccent);

    win.once('ready-to-show', () => {
        if (!startupFailed) win.show();
    });

    win.on('closed', () => {
        if (mainWindow === win) mainWindow = null;
    });

    // Never let the renderer open a new window; only https links go to the OS browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('https://')) {
            shell.openExternal(url).catch((error) => {
                console.error('[main] Failed to open external link:', error.message);
            });
        }
        return { action: 'deny' };
    });

    // The UI is a single-page app served from the local backend: block all navigation.
    win.webContents.on('will-navigate', (event) => {
        event.preventDefault();
    });

    loadServerUrl();
    return win;
}

function stopBackend() {
    const child = backend && backend.child;
    backend = null;
    if (!child) return;
    // Ask for an orderly quit over the IPC channel first. On Windows `utilityProcess.kill()` is
    // TerminateProcess, so the server's SIGTERM handler never runs and its Studio MCP child (plus the
    // SQLite handle) is orphaned; the message is what actually reaches the shutdown path. The kill
    // stays as the backstop for a server that is wedged.
    let killed = false;
    const force = setTimeout(() => {
        killed = true;
        try {
            child.kill();
        } catch (error) {
            console.error('[main] Failed to stop server:', error.message);
        }
    }, 2500);
    force.unref?.();
    child.once('exit', () => clearTimeout(force));
    try {
        child.postMessage({ type: 'shutdown' });
    } catch (error) {
        if (!killed) console.error('[main] Failed to ask the server to quit:', error.message);
    }
}

function failStartup(error) {
    if (startupFailed || shuttingDown) return;
    startupFailed = true;
    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }
    stopBackend();
    const message = error && error.message ? error.message : String(error);
    console.error('[main] Server startup failed:', message);
    dialog.showErrorBox(STARTUP_ERROR_TITLE, message);
    app.quit();
}

function shutdown() {
    shuttingDown = true;
    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }
    stopBackend();
}

function onServerExit(entry, code) {
    if (backend === entry) backend = null;
    if (shuttingDown || startupFailed) return;
    if (restartCount >= RESTART_DELAYS_MS.length) {
        failStartup(new Error(`SERVER_EXITED_${code}`));
        return;
    }
    const delay = RESTART_DELAYS_MS[restartCount];
    restartCount += 1;
    console.error(`[main] Server exited with code ${code}; restarting in ${delay}ms (attempt ${restartCount}/${RESTART_DELAYS_MS.length})`);
    restartTimer = setTimeout(() => {
        restartTimer = null;
        startServer();
    }, delay);
}

function startServer() {
    if (shuttingDown || startupFailed) return;

    let entry;
    try {
        entry = startBackend({ appPath: app.getAppPath(), env: process.env });
    } catch (error) {
        failStartup(error);
        return;
    }

    backend = entry;
    entry.child.on('exit', (code) => onServerExit(entry, code));

    entry.ready
        .then(({ port }) => {
            if (shuttingDown || startupFailed || backend !== entry) return;
            serverPort = port;
            // The restart budget covers consecutive failures only.
            restartCount = 0;
            // The server holds keys in memory; give it the current snapshot after
            // every (re)start, before the renderer can ask for anything.
            pushCredentials();
            if (mainWindow) {
                // Restart: point the existing window at the new port.
                loadServerUrl();
            } else {
                createWindow();
            }
        })
        .catch((error) => {
            if (backend !== entry || shuttingDown || startupFailed) return;
            if (error && error.message === 'SERVER_START_TIMEOUT') {
                failStartup(error);
            }
            // SERVER_EXITED_* is handled by onServerExit so the restart policy applies.
        });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', focusMainWindow);

    app.on('before-quit', shutdown);

    app.on('will-quit', () => {
        globalShortcut.unregisterAll();
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });

    app.on('activate', () => {
        if (!mainWindow && serverPort !== null) createWindow();
    });

    ipcMain.handle('morphi:token', (event) => {
        assertTrustedSender(event);
        if (!backend) throw new Error('BACKEND_NOT_READY');
        return backend.token;
    });

    // Titlebar menu commands: the renderer owns the labels, main owns the window.
    ipcMain.handle('morphi:window', (event, args) => {
        assertTrustedSender(event);
        const action = args && typeof args.action === 'string' ? args.action : '';
        const win = mainWindow;
        switch (action) {
            case 'close':
                win?.close();
                break;
            case 'quit':
                app.quit();
                break;
            case 'reload':
                win?.reload();
                break;
            case 'devtools':
                if (win) {
                    if (win.webContents.isDevToolsOpened()) {
                        win.webContents.closeDevTools();
                    } else {
                        win.webContents.openDevTools({ mode: 'detach' });
                    }
                }
                break;
            case 'zoom-in':
            case 'zoom-out':
            case 'zoom-reset': {
                if (!win) break;
                const current = win.webContents.getZoomFactor();
                const next = action === 'zoom-reset'
                    ? 1
                    : Math.min(2.5, Math.max(0.5, current + (action === 'zoom-in' ? 0.1 : -0.1)));
                win.webContents.setZoomFactor(Math.round(next * 10) / 10);
                break;
            }
            case 'fullscreen':
                if (win) win.setFullScreen(!win.isFullScreen());
                break;
            case 'about':
                dialog.showMessageBox({
                    type: 'info',
                    title: 'Morphi Intelligence',
                    message: `Morphi Intelligence ${app.getVersion()}`,
                    detail: 'Roblox Studio AI Orchestrator',
                });
                break;
            default:
                throw new Error('INVALID_ARGUMENT');
        }
        return { ok: true };
    });

    // The renderer pushes the effective app theme so the native caption overlay matches the strip.
    ipcMain.on('morphi:theme', (event, theme) => {
        assertTrustedSender(event);
        if (theme !== 'dark' && theme !== 'light') return;
        syncTitlebarChrome(theme);
    });

    // Pull endpoint for the system accent: an event push alone can race the renderer subscription
    // (did-finish-load fires before React mounts), so the hook also asks once on mount.
    ipcMain.handle('morphi:accent', (event) => {
        assertTrustedSender(event);
        return {
            accent: normalizeAccent(systemPreferences.getAccentColor()),
            dark: nativeTheme.shouldUseDarkColors,
        };
    });

    // System accent (Windows follows the wallpaper) + OS theme changes, pushed live. An accent
    // change also re-tints the native caption chrome with the current app theme.
    systemPreferences.on('accent-color-changed', () => {
        pushSystemAccent();
        syncTitlebarChrome(lastTheme);
    });
    nativeTheme.on('updated', pushSystemAccent);

    app.whenReady()
        .then(() => {
            // No native menu (merged-titlebar design): keep the two developer shortcuts that a menu
            // used to provide — reload and DevTools — as global accelerators.
            globalShortcut.register('F5', () => mainWindow?.reload());
            globalShortcut.register('CommandOrControl+R', () => mainWindow?.reload());
            globalShortcut.register('CommandOrControl+Shift+I', () => {
                if (!mainWindow) return;
                if (mainWindow.webContents.isDevToolsOpened()) {
                    mainWindow.webContents.closeDevTools();
                } else {
                    mainWindow.webContents.openDevTools({ mode: 'detach' });
                }
            });
            const store = createCredentialStore({
                safeStorage,
                filePath: path.join(app.getPath('userData'), 'credentials.json'),
            });
            pushCredentials = registerIpc({ ipcMain, store, getBackend: () => backend }).push;
            startServer();
        })
        .catch((error) => failStartup(error));
}
