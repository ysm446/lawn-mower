// 画面の録画(weather-globe の screen-recorder.ts を移植。音楽は無いので映像だけ)。
// Ctrl+F12(メインプロセスから届く)で始めて止める。ウィンドウの中身を getDisplayMedia で受け取り、
// MediaRecorder で書き出す。中身は 1 秒ごとにメインプロセスへ送り、recordings/ のファイルに追記する(main/recording.ts)。
// 大きさは今のウィンドウの物理ピクセルのまま。きっちりした大きさにしたいときは、先に動画用サイズ(F11)にする

const CHUNK_MS = 1000
/** 1 画素 1 コマあたりのビット数。1920×1080、30 コマで約 12 Mbps */
const BITS_PER_PIXEL = 0.2
const MIN_VIDEO_BPS = 8_000_000
const MAX_VIDEO_BPS = 60_000_000

// 使える最初の形式で書き出す。Electron は MP4(H.264)を直接書ける。
// avc1.640034 は High プロファイルのレベル 5.2 で、4K 60 コマまで収まる
const FORMATS: Array<{ mimeType: string; extension: 'mp4' | 'webm' }> = [
  { mimeType: 'video/mp4;codecs=avc1.640034', extension: 'mp4' },
  { mimeType: 'video/mp4;codecs=avc1', extension: 'mp4' },
  { mimeType: 'video/mp4', extension: 'mp4' },
  { mimeType: 'video/webm;codecs=vp9', extension: 'webm' },
  { mimeType: 'video/webm', extension: 'webm' }
]

/** H.264 は縦横が奇数だと書けないので、偶数に切り下げる */
function evenSize(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2)
}

function videoBitrate(width: number, height: number, fps: number): number {
  return Math.round(Math.min(MAX_VIDEO_BPS, Math.max(MIN_VIDEO_BPS, width * height * fps * BITS_PER_PIXEL)))
}

export function initScreenRecorder(options: {
  /** 設定の「録画のコマ数」 */
  fps: () => number
  /** 設定の「マウスポインタを写す」 */
  cursor: () => boolean
  /** 保存したとき。保存できなかったときは null */
  onSaved: (filePath: string | null) => void
}): void {
  const api = window.lawnApi
  if (!api) return
  let session: { recorder: MediaRecorder; stopped: Promise<string | null> } | null = null
  let starting = false

  async function start(): Promise<void> {
    const fps = options.fps() === 60 ? 60 : 30
    const ratio = window.devicePixelRatio
    const width = evenSize(window.innerWidth * ratio)
    const height = evenSize(window.innerHeight * ratio)
    // cursor は画面の取り込みの制約(Chromium が対応している)。'never' でマウスポインタを描かない。
    // 画面の上のポインタはそのまま見える。TypeScript の型には無いので、足して渡す
    const video = {
      width: { ideal: width, max: width },
      height: { ideal: height, max: height },
      frameRate: { ideal: fps, max: fps },
      cursor: options.cursor() ? 'always' : 'never'
    } as MediaTrackConstraints
    const stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: false })
    const format = FORMATS.find((f) => MediaRecorder.isTypeSupported(f.mimeType))
    if (!format) {
      stream.getTracks().forEach((track) => track.stop())
      throw new Error('録画できる形式がありません')
    }
    const recorder = new MediaRecorder(stream, {
      mimeType: format.mimeType,
      videoBitsPerSecond: videoBitrate(width, height, fps)
    })
    await api!.recordingBegin(format.extension)

    let writing = Promise.resolve()
    let failed = false
    // 送る順番を保つため、前の書き込みを待ってから次を送る
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size === 0) return
      writing = writing
        .then(async () => api!.recordingChunk(new Uint8Array(await event.data.arrayBuffer())))
        .catch((err) => {
          failed = true
          console.error('recording write failed', err)
        })
    })
    const stopped = new Promise<string | null>((resolve) => {
      recorder.addEventListener('stop', () => {
        stream.getTracks().forEach((track) => track.stop())
        void writing
          .then(() => api!.recordingEnd())
          .then((saved) => resolve(failed ? null : saved))
          .catch((err) => {
            console.error('recording end failed', err)
            resolve(null)
          })
      })
    })
    // ウィンドウが閉じたときなど、映像が途切れたら止める
    stream.getVideoTracks()[0]?.addEventListener('ended', () => void stop())
    recorder.start(CHUNK_MS)
    session = { recorder, stopped }
  }

  async function stop(): Promise<void> {
    const current = session
    if (!current) return
    session = null
    if (current.recorder.state !== 'inactive') current.recorder.stop()
    options.onSaved(await current.stopped)
  }

  api.onRecordingToggle(() => {
    if (starting) return
    if (session) {
      void stop()
      return
    }
    starting = true
    start()
      .catch((err) => {
        console.error('recording failed', err)
        options.onSaved(null)
      })
      .finally(() => {
        starting = false
      })
  })
}
