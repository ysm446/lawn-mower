import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import appIcon from '../../resources/icons/lawn-mower-overhead.png?asset'
import {
  abortRecording,
  initRecording,
  isRecordingPath,
  resetZoomOnLoad,
  setWindowContentSize,
  toggleVideoSize,
  watchWindowTitle
} from './recording'

// 動作確認用の環境変数:
//   LM_QUERY            レンダラーに渡すクエリ文字列(例: "auto=1&timescale=16&cam=orbit")
//   LM_SCREENSHOT       指定すると、そのパスに画面を保存して終了する
//   LM_SCREENSHOT_DELAY 保存までの待ち時間(ミリ秒)。既定は 5000
const query = process.env.LM_QUERY ?? ''
const screenshotPath = process.env.LM_SCREENSHOT
const screenshotDelay = Number(process.env.LM_SCREENSHOT_DELAY ?? 5000)

// 動作確認で画面を撮るとき(LM_SCREENSHOT)は、保存先(設定やパネルの値を入れる localStorage など)を
// ふだんのものから切り離し、一時フォルダの起動ごとに新しい場所を使う。
// ふだん使っているアプリと同時に起動しても、設定を読めなくなったり書き換えたりしないように、
// また撮る画面が保存した設定に左右されず、いつも既定の状態から始まるようにするため。
// 前の確認で作った場所は、ここで片付ける(使っている途中のものは消せないので、そのまま残る)
if (screenshotPath) {
  const root = join(tmpdir(), 'lawn-mower-check')
  try {
    for (const name of readdirSync(root)) rmSync(join(root, name), { recursive: true, force: true })
  } catch {
    // まだ無いか、使っている途中で消せないものがある
  }
  app.setPath('userData', join(root, `run-${process.pid}`))
}

// 保存するもの(スクリーンショット、録画)の置き場所。アプリのフォルダの data/(Git の管理に入れない)
function dataDir(): string {
  return join(app.getAppPath(), 'data')
}

// スクリーンショット(weather-globe と同じ操作)。F12 で画面の画素のまま、Shift+F12 で表示倍率 100% 相当の大きさで、
// data/screenshots/ に PNG で保存する。保存したら画面に知らせ、通知のクリックで保存先を開く
function screenshotDir(): string {
  return join(dataDir(), 'screenshots')
}

// 録画の保存先
function recordingDir(): string {
  return join(dataDir(), 'recordings')
}

// 通知のクリックから保存先を開く。スクリーンショットと録画のフォルダの中だけ受け付ける
ipcMain.handle('screenshot:reveal', (_event, filePath: string) => {
  const allowed = dirname(filePath) === screenshotDir() || isRecordingPath(filePath)
  if (allowed && existsSync(filePath)) shell.showItemInFolder(filePath)
})

// 設定のウィンドウサイズ(recording.ts)。頼んできた画面のウィンドウを変える
ipcMain.handle('window:set-size', (event, width: number, height: number) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) setWindowContentSize(win, width, height)
})

// 連続で撮っても前の通知が写らないよう、通知を隠して、消えた画面が描かれるまで待つ
const HIDE_TOAST_SCRIPT = `new Promise((resolve) => {
  document.getElementById('screenshot-toast')?.setAttribute('hidden', '');
  requestAnimationFrame(() => requestAnimationFrame(resolve));
})`

// capturePage は物理ピクセルで撮る。logical(Shift+F12)のときはウィンドウの論理サイズへ縮め、
// 表示倍率 100% で同じ大きさのウィンドウを撮ったときの画素数にする。構図は変わらない
async function captureScreenshot(win: BrowserWindow, logical: boolean): Promise<void> {
  let filePath: string | null = null
  try {
    await win.webContents.executeJavaScript(HIDE_TOAST_SCRIPT)
    let image = await win.webContents.capturePage()
    if (logical) {
      const [width, height] = win.getContentSize()
      image = image.resize({ width, height, quality: 'best' })
    }
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    await mkdir(screenshotDir(), { recursive: true })
    filePath = join(screenshotDir(), `screenshot-${stamp}${logical ? '-100pct' : ''}.png`)
    await writeFile(filePath, image.toPNG())
  } catch (err) {
    console.error('screenshot failed', err)
    filePath = null
  }
  if (!win.isDestroyed()) win.webContents.send('screenshot:done', filePath)
}

function createWindow(): void {
  // 既定の大きさは、中身(タイトルバーを除く)で 1920×1080(weather-globe と同じ)
  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    useContentSize: true,
    icon: appIcon,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  watchWindowTitle(win)
  resetZoomOnLoad(win)
  // 画面を読み直したら、録画はそこまでの分で閉じる
  win.webContents.on('did-start-loading', () => abortRecording(win))

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.loadURL(query ? `${devUrl}?${query}` : devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { search: query })
  }

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    // F12 は物理ピクセルのまま、Shift+F12 は表示倍率 100% 相当の大きさで保存する。
    // Ctrl+F12 で録画の開始と停止、F11 で動画用サイズ(1920×1080)への切り替えと戻し(recording.ts)。
    // 標準のメニューの動き(F11 の全画面表示など)が重ならないよう、受け取ったキーは既定の動きを止める
    if (input.key === 'F12' && !input.alt) {
      event.preventDefault()
      if (input.isAutoRepeat) return
      if (!input.control) void captureScreenshot(win, input.shift)
      else if (!input.shift) win.webContents.send('recording:toggle')
    }
    if (input.key === 'F11' && !input.control && !input.shift && !input.alt) {
      event.preventDefault()
      if (!input.isAutoRepeat) toggleVideoSize(win)
    }
  })

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
  initRecording(recordingDir())
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
