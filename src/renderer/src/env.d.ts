// preload(src/preload/index.ts)が画面に出す API の型

interface LawnApi {
  revealScreenshot(filePath: string): Promise<void>
  onScreenshot(callback: (filePath: string | null) => void): void
  onRecordingToggle(callback: () => void): void
  recordingBegin(extension: string): Promise<string>
  recordingChunk(chunk: Uint8Array): Promise<void>
  recordingEnd(): Promise<string | null>
}

interface Window {
  /** Electron の外(ブラウザで開いたときなど)では無い */
  lawnApi?: LawnApi
}
