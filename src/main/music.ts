// 音楽(weather-globe の音楽のボタンを移植)のメインプロセスの側。
// 音源のパスを決めるのはこちらのファイル選択ダイアログだけにし、画面から任意のファイルを読めないようにする。
// 選んだパスは userData の music.json に覚え、lawn-audio:// の読み込み口では、どの URL でもその音源だけを返す

import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'

const AUDIO_SCHEME = 'lawn-audio'
const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac']

/** 音源を少しずつ読むための読み込み口を登録する。app の準備ができる前に呼ぶ */
export function registerAudioScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: AUDIO_SCHEME, privileges: { standard: true, stream: true } }])
}

// 動作確認で画面を撮る起動では userData が一時フォルダに切り替わるので、使うときに場所を求める
function storePath(): string {
  return join(app.getPath('userData'), 'music.json')
}

/** 選んである音源のパス。undefined はまだ読んでいない */
let current: string | null | undefined

async function loadFile(): Promise<string | null> {
  if (current !== undefined) return current
  try {
    const saved = JSON.parse(await readFile(storePath(), 'utf8')) as { file?: unknown }
    current = typeof saved.file === 'string' ? saved.file : null
  } catch {
    current = null
  }
  return current
}

async function saveFile(file: string | null): Promise<void> {
  current = file
  await mkdir(dirname(storePath()), { recursive: true })
  await writeFile(storePath(), JSON.stringify({ file }), 'utf8')
}

/** Range ヘッダー(bytes=始め-終わり)を読む。読めない、範囲外なら null(全体を返す) */
function parseByteRange(header: string | null, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '')
  if (!match || (match[1] === '' && match[2] === '')) return null
  let start: number
  let end: number
  if (match[1] === '') {
    // 末尾から数えた長さ
    start = Math.max(0, size - Number(match[2]))
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  }
  if (start > end || start >= size) return null
  return { start, end }
}

// ループの先頭へ戻るにはシークが要るので、Range に応える
async function audioResponse(file: string, rangeHeader: string | null): Promise<Response> {
  const size = await stat(file).then(
    (s) => s.size,
    () => 0
  )
  if (size === 0) return new Response(null, { status: 404 })
  const range = parseByteRange(rangeHeader, size)
  const { start, end } = range ?? { start: 0, end: size - 1 }
  const headers: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Content-Length': String(end - start + 1)
  }
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream
  return new Response(body, { status: range ? 206 : 200, headers })
}

/** 音源をまだ選んでいないとき、ダイアログで初めに開くフォルダ。アプリの assets/bgm/(weather-globe と同じ)、無ければ「ミュージック」 */
function defaultFolder(): string {
  const bgm = join(app.getAppPath(), 'assets', 'bgm')
  return existsSync(bgm) ? bgm : app.getPath('music')
}

/** 読み込み口と、画面とのやり取りを用意する。app の準備ができてから呼ぶ */
export function initMusic(): void {
  protocol.handle(AUDIO_SCHEME, async (request) => {
    const file = await loadFile()
    return file ? audioResponse(file, request.headers.get('range')) : new Response(null, { status: 404 })
  })
  ipcMain.handle('music:get', () => loadFile())
  // 選んだパスを返す。キャンセルしたら null
  ipcMain.handle('music:choose', async (event) => {
    const options: Electron.OpenDialogOptions = {
      title: '音源ファイルを選ぶ',
      defaultPath: (await loadFile()) ?? defaultFolder(),
      properties: ['openFile'],
      filters: [{ name: '音声ファイル', extensions: AUDIO_EXTENSIONS }]
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    await saveFile(result.filePaths[0])
    return result.filePaths[0]
  })
  ipcMain.handle('music:clear', () => saveFile(null))
}
