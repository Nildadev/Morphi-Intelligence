const { app, BrowserWindow } = require('electron');
const path = require('path');
const http = require('http');

let mainWindow;

// Khởi động Backend trực tiếp từ main process
function startBackend() {
    try {
        // Đường dẫn tới file server đã build
        const serverPath = path.join(__dirname, 'server/dist/index.js');
        require(serverPath);
        console.log('Backend server started internally.');
    } catch (error) {
        console.error('Failed to start backend:', error);
    }
}

function waitForServer(url) {
    return new Promise((resolve) => {
        const check = () => {
            http.get(url, (res) => {
                if (res.statusCode === 200) {
                    resolve();
                } else {
                    setTimeout(check, 500);
                }
            }).on('error', () => {
                setTimeout(check, 500);
            });
        };
        check();
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        title: "Morphi Intelligence",
        autoHideMenuBar: true, // Tự động ẩn menu
        icon: path.join(__dirname, 'logo.png'), // Icon cho cửa sổ
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
        backgroundColor: '#ffffff',
        show: false
    });

    // Xóa bỏ thanh menu hoàn toàn (ẩn Toolbar)
    mainWindow.setMenu(null);

    const serverUrl = 'http://localhost:3000';
    waitForServer(serverUrl).then(() => {
        mainWindow.loadURL(serverUrl);
        mainWindow.show();
    });

    mainWindow.on('closed', () => mainWindow = null);
}

app.on('ready', () => {
    startBackend();
    createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
        // Buộc thoát hoàn toàn để giết các tiến trình con (Express, MCP)
        process.exit(0);
    }
});

app.on('activate', () => {
    if (mainWindow === null) createWindow();
});
