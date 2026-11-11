import { app, BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import appIcon from '../../resources/icons/lawn-mower-overhead.png?asset'

// 動作確認用の環境変数:
//   LM_QUERY            レンダラーに渡すクエリ文字列(例: "auto=1&timescale=16&cam=orbit")
//   LM_SCREENSHOT       指定すると、そのパスに画面を保存して終了する
//   LM_SCREENSHOT_DELAY 保存までの待ち時間(ミリ秒)。既定は 5000
const query = process.env.LM_QUERY ?? ''
const screenshotPath = process.env.LM_SCREENSHOT
const screenshotDelay = Number(process.env.LM_SCREENSHOT_DELAY ?? 5000)

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    icon: appIcon,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.loadURL(query ? `${devUrl}?${query}` : devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { search: query })
  }

  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      console.log(`[renderer ${event.level}] ${event.message}`)
    }
  })

  if (screenshotPath) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void win.webContents
          .capturePage()
          .then((image) => writeFile(screenshotPath, image.toPNG()))
          .catch((err) => console.error(err))
          .finally(() => app.quit())
      }, screenshotDelay)
    })
  }
}

void app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
