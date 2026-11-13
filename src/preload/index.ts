// 画面(レンダラー)とメインプロセスをつなぐ。画面からは window.lawnApi で使う

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('lawnApi', {
  /** スクリーンショットの保存先をエクスプローラーで開く */
  revealScreenshot: (filePath: string): Promise<void> => ipcRenderer.invoke('screenshot:reveal', filePath),
  /** スクリーンショットを保存したとき(F12)。失敗したら null */
  onScreenshot: (callback: (filePath: string | null) => void): void => {
    ipcRenderer.on('screenshot:done', (_event, filePath: string | null) => callback(filePath))
  },
  /** Ctrl+F12 が押されたとき(録画の開始と停止) */
  onRecordingToggle: (callback: () => void): void => {
    ipcRenderer.on('recording:toggle', () => callback())
  },
  /** 録画を始める。保存先のパスを返す */
  recordingBegin: (extension: string): Promise<string> => ipcRenderer.invoke('recording:begin', extension),
  /** 録画の中身を書き足す */
  recordingChunk: (chunk: Uint8Array): Promise<void> => ipcRenderer.invoke('recording:chunk', chunk),
  /** 録画を書き終える。保存したパス、中身が空なら null */
  recordingEnd: (): Promise<string | null> => ipcRenderer.invoke('recording:end'),
  /** ウィンドウの中身の大きさを変える(画面の表示倍率を掛けた、見た目の大きさ) */
  setWindowSize: (width: number, height: number): Promise<void> =>
    ipcRenderer.invoke('window:set-size', width, height),
  /** 選んである音楽の音源のパス。選んでいなければ null */
  getMusicFile: (): Promise<string | null> => ipcRenderer.invoke('music:get'),
  /** ファイル選択ダイアログで音源を選ぶ。選んだパスを返し、キャンセルしたら null */
  chooseMusicFile: (): Promise<string | null> => ipcRenderer.invoke('music:choose'),
  /** 音源を外す */
  clearMusicFile: (): Promise<void> => ipcRenderer.invoke('music:clear')
})
