// 画面の録画と動画用サイズ(メインプロセスの側。weather-globe の recording.ts を移植)。
// 録画そのもの(MediaRecorder)は画面で行い、ここでは映す対象の指定、ファイルへの書き出し、
// タイトルバーの表示、動画用サイズへの切り替えを受け持つ。録画中の印を画面に出すと動画に写るので、タイトルバーに出す

import { BrowserWindow, ipcMain, screen, session, type WebContents } from 'electron'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// 動画用サイズ: この物理ピクセルの大きさで、表示倍率 100% と同じ構図に描く
export const VIDEO_WIDTH = 1920
export const VIDEO_HEIGHT = 1080

let recordingDir = ''
let output: { stream: WriteStream; filePath: string } | null = null
let recordingSince = 0
let titleTimer: NodeJS.Timeout | null = null
let videoSize: { bounds: Electron.Rectangle; content: [number, number]; maximized: boolean; zoom: number } | null = null

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function stamp(now: Date): string {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

export function isRecordingPath(filePath: string): boolean {
  return recordingDir !== '' && dirname(filePath) === recordingDir
}

// タイトルバーに、録画中の経過時間と動画用サイズかどうかを出す
function updateTitle(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const parts: string[] = []
  if (recordingSince) {
    const seconds = Math.floor((Date.now() - recordingSince) / 1000)
    parts.push(`● 録画中 ${Math.floor(seconds / 60)}:${pad(seconds % 60)}`)
  }
  if (videoSize) parts.push(`動画用サイズ ${VIDEO_WIDTH}×${VIDEO_HEIGHT}`)
  const base = win.webContents.getTitle()
  win.setTitle(parts.length ? `${parts.join(' ・ ')} — ${base}` : base)
}

function senderWindow(sender: WebContents): BrowserWindow | null {
  return BrowserWindow.fromWebContents(sender)
}

/** 録画の受け口を用意する。dir は録画を保存するフォルダ */
export function initRecording(dir: string): void {
  recordingDir = dir

  // getDisplayMedia で、頼んできた画面そのもの(タイトルバーを含まない中身)を映す。選ぶ画面は出さない
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (request.frame) callback({ video: request.frame })
    else callback({})
  })

  ipcMain.handle('recording:begin', async (event, extension: string) => {
    if (output) throw new Error('録画中です')
    const ext = extension === 'webm' ? 'webm' : 'mp4'
    await mkdir(recordingDir, { recursive: true })
    const filePath = join(recordingDir, `recording-${stamp(new Date())}.${ext}`)
    output = { stream: createWriteStream(filePath), filePath }
    recordingSince = Date.now()
    const win = senderWindow(event.sender)
    if (win) {
      updateTitle(win)
      titleTimer = setInterval(() => updateTitle(win), 1000)
    }
    return filePath
  })

  ipcMain.handle('recording:chunk', (_event, chunk: Uint8Array) => {
    const target = output
    if (!target) return
    return new Promise<void>((resolve, reject) => {
      target.stream.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength), (err) =>
        err ? reject(err) : resolve()
      )
    })
  })

  // 書き終えたファイルのパスを返す。中身が空なら消して null
  ipcMain.handle('recording:end', async (event) => finishRecording(senderWindow(event.sender)))
}

async function finishRecording(win: BrowserWindow | null): Promise<string | null> {
  const target = output
  output = null
  recordingSince = 0
  if (titleTimer) clearInterval(titleTimer)
  titleTimer = null
  if (win) updateTitle(win)
  if (!target) return null
  await new Promise<void>((resolve) => target.stream.end(resolve))
  const size = await stat(target.filePath).then(
    (s) => s.size,
    () => 0
  )
  if (size > 0) return target.filePath
  await rm(target.filePath, { force: true })
  return null
}

// 画面を読み直すと録画も途切れるので、そこまでの分でファイルを閉じる
export function abortRecording(win: BrowserWindow): void {
  if (output) void finishRecording(win)
}

// 拡大率は Electron がプロファイルに覚えていて、動画用サイズのまま閉じると次の起動で文字が小さくなる。
// 画面を読み込むたびに(動画用サイズの間を除いて)1 に戻す
export function resetZoomOnLoad(win: BrowserWindow): void {
  win.webContents.on('did-finish-load', () => {
    if (!videoSize) win.webContents.setZoomFactor(1)
  })
}

// 画面のタイトルが変わっても、録画中と動画用サイズの印を残す
export function watchWindowTitle(win: BrowserWindow): void {
  win.on('page-title-updated', (event) => {
    if (!recordingSince && !videoSize) return
    event.preventDefault()
    updateTitle(win)
  })
}

// 動画用サイズ: F11 で切り替える。表示倍率を打ち消すよう画面を縮小表示し、中身を物理ピクセルで VIDEO_WIDTH×VIDEO_HEIGHT にする。
// CSS の大きさも VIDEO_WIDTH×VIDEO_HEIGHT になるので、表示倍率 100% のモニターで見たのと同じ構図を、拡大縮小なしで描く。
// 戻すときは、切り替える前の位置、大きさ、最大化、拡大率に戻す。録画中に変えると途中で構図が変わるので受け付けない
function setVideoSize(win: BrowserWindow, enabled: boolean): void {
  if (output) return
  if (!enabled) {
    const saved = videoSize
    if (!saved) return
    videoSize = null
    win.webContents.setZoomFactor(saved.zoom)
    win.setBounds(saved.bounds)
    win.setContentSize(...saved.content) // 表示倍率によっては枠の大きさの換算で 1px ずれるので、中身の大きさで合わせる
    if (saved.maximized) win.maximize()
    updateTitle(win)
    return
  }
  if (!videoSize) {
    const maximized = win.isMaximized()
    if (maximized) win.unmaximize()
    const [width, height] = win.getContentSize()
    videoSize = { bounds: win.getNormalBounds(), content: [width, height], maximized, zoom: win.webContents.getZoomFactor() }
  }
  if (win.isFullScreen()) win.setFullScreen(false)
  const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor
  win.webContents.setZoomFactor(1 / scale)
  win.setContentSize(Math.round(VIDEO_WIDTH / scale), Math.round(VIDEO_HEIGHT / scale))
  updateTitle(win)
}

// 設定のウィンドウサイズ。中身の大きさを、画面の表示倍率を掛けた見た目の大きさで合わせ、画面の作業領域の中央に置く。
// 動画用サイズの間と録画中は、構図が変わるので受け付けない
export function setWindowContentSize(win: BrowserWindow, width: number, height: number): void {
  if (output || videoSize) return
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 320 || height < 180) return
  if (win.isFullScreen()) win.setFullScreen(false)
  if (win.isMaximized()) win.unmaximize()
  win.setContentSize(Math.round(width), Math.round(height))
  win.center()
}

// キー(F11)からの切り替え。録画中は何もしない
export function toggleVideoSize(win: BrowserWindow): void {
  if (!output) setVideoSize(win, videoSize === null)
}
