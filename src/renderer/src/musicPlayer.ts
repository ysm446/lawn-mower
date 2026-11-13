// 音楽(weather-globe の music-player.ts を移植)。
// 右上の音楽のボタンを押すと、再生と停止が切り替わり、アイコンも変わる(止まっているときは音符、鳴っているときはスピーカー)。
// ボタンにカーソルを合わせる(キーボードではフォーカスする)と、下に縦の音量バーが出る。
// 設定ウインドウの「音楽」タブで選んだ音源をループで再生する。起動しただけでは鳴らさない。
// 音源のパスはメインプロセスが覚え(main/music.ts)、画面は lawn-audio:// から読む

import type { Sync } from './ui'
import { byId } from './ui'

/** どの URL でも、設定で選んだ音源が返る */
const AUDIO_URL = 'lawn-audio://current/'
const PLAY_FAILED = '音源を再生できません。ファイルが移動や削除されていないか確かめてください。'
/** ボタンから音量バーへカーソルを移す間に消えないようにする(ミリ秒) */
const HIDE_DELAY_MS = 250
/** カーソルが乗っていないときに、再生できない知らせを見せておく時間(ミリ秒) */
const ERROR_SHOW_MS = 4000
/** ボタンと音量バーの間(px) */
const POPUP_GAP = 6

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath
}

function setStatus(target: HTMLElement, message: string, isError = false): void {
  target.textContent = message
  target.classList.toggle('error', isError)
}

export interface MusicPlayer {
  /** 設定ウインドウの「音楽」タブの中身を作る */
  buildSettings(panel: HTMLElement): Sync
  /** 音量を設定の値に合わせ直す(「すべて既定に戻す」のあとなど) */
  syncVolume(): void
}

export function initMusicPlayer(options: {
  /** 音量(0〜1) */
  volume: () => number
  /** 音量バーを動かし終えたとき。保存する */
  setVolume: (value: number) => void
  /** 音源を選んでいないときにボタンを押したら、設定の「音楽」タブを開く */
  openSettings: () => void
}): MusicPlayer {
  const api = window.lawnApi
  const toggle = byId<HTMLButtonElement>('music-toggle')
  const popup = byId('music-popup')
  const volume = byId<HTMLInputElement>('music-volume')
  const status = byId('music-status')

  const audio = new Audio()
  audio.loop = true
  audio.preload = 'none'
  let file: string | null = null
  let loads = 0
  let hideTimer = 0
  // 設定ウインドウの「音楽」タブを、音源が変わったときに書き換える
  let refreshSettings: Sync = () => {}

  // Electron の外(ブラウザで開いたとき)は音源を選べないので、ボタンを出さない
  if (!api) toggle.hidden = true

  // 音源を選んでいないときは、出しても動かすものがないので出さない
  function showPopup(): void {
    window.clearTimeout(hideTimer)
    if (!file && !status.textContent) return
    popup.hidden = false
    const button = toggle.getBoundingClientRect()
    popup.style.top = `${button.bottom + POPUP_GAP}px`
    // 知らせで広がったときも画面の右端からはみ出さないようにする
    const left = Math.min(
      button.left + button.width / 2 - popup.offsetWidth / 2,
      window.innerWidth - popup.offsetWidth - 8
    )
    popup.style.left = `${left}px`
  }

  function hidePopupSoon(delay = HIDE_DELAY_MS): void {
    window.clearTimeout(hideTimer)
    hideTimer = window.setTimeout(() => {
      // カーソルが乗っている間と、キーボードで操作している間は出したままにする
      if (toggle.matches(':hover') || popup.matches(':hover')) return
      const focused = document.activeElement
      const usingKeyboard =
        focused?.matches(':focus-visible') && (focused === toggle || popup.contains(focused))
      if (usingKeyboard) return
      popup.hidden = true
      // 知らせは一度見せたら消す
      setStatus(status, '')
    }, delay)
  }

  for (const element of [toggle, popup]) {
    element.addEventListener('pointerenter', showPopup)
    element.addEventListener('pointerleave', () => hidePopupSoon())
    element.addEventListener('focusin', showPopup)
    element.addEventListener('focusout', () => hidePopupSoon())
    element.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || popup.hidden) return
      popup.hidden = true
      toggle.focus()
    })
  }

  function syncPlaying(): void {
    const playing = !audio.paused
    toggle.classList.toggle('playing', playing)
    toggle.setAttribute('aria-pressed', String(playing))
    const label = !file
      ? '音楽(設定で音源を選ぶ)'
      : `${playing ? '音楽を止める' : '音楽を再生'}: ${fileName(file)}`
    toggle.setAttribute('aria-label', label)
    toggle.title = label
  }
  audio.addEventListener('play', syncPlaying)
  audio.addEventListener('pause', syncPlaying)
  audio.addEventListener('error', () => {
    if (file) showError()
    // 読めなくても、再生の指示が残ったままになる
    audio.pause()
    syncPlaying()
  })

  // 知らせは音量バーの下に出す。カーソルが離れると消える
  function showError(): void {
    setStatus(status, PLAY_FAILED, true)
    showPopup()
    hidePopupSoon(ERROR_SHOW_MS)
  }

  async function play(): Promise<void> {
    setStatus(status, '')
    // ファイルを戻したあとに押し直せるようにする
    if (audio.error) audio.load()
    try {
      await audio.play()
    } catch (err) {
      // 再生の直後に止めると AbortError になる。読めないときの知らせは error のイベントでも出す
      if (!(err instanceof DOMException && err.name === 'AbortError')) showError()
    }
  }

  toggle.addEventListener('click', () => {
    if (!file) options.openSettings()
    else if (audio.paused) void play()
    else audio.pause()
    // Space などの運転のキーがボタンに取られないように、マウスで押したらフォーカスを外す
    if (!toggle.matches(':focus-visible')) toggle.blur()
  })

  function showVolume(): void {
    const position = Number(volume.value) / 100
    // 耳の感じ方に合わせ、小さい音量の側を細かく変えられるようにする
    audio.volume = position * position
    volume.setAttribute('aria-valuetext', `${volume.value}%`)
    volume.title = `音量 ${volume.value}%`
    volume.style.setProperty('--fill', `${volume.value}%`)
  }
  function syncVolume(): void {
    volume.value = String(Math.round(options.volume() * 100))
    showVolume()
  }
  volume.addEventListener('input', showVolume)
  volume.addEventListener('change', () => {
    options.setVolume(Number(volume.value) / 100)
    // 矢印キーなどの運転のキーが音量バーに取られないように、マウスで動かしたらフォーカスを外す
    if (!volume.matches(':focus-visible')) volume.blur()
  })
  syncVolume()

  function setFile(next: string | null): void {
    const playing = !audio.paused
    file = next
    setStatus(status, '')
    if (!file) popup.hidden = true
    audio.pause()
    if (file) {
      // 同じ URL だと前の音源が残る
      audio.src = `${AUDIO_URL}${++loads}`
      if (playing) void play()
    } else {
      audio.removeAttribute('src')
      audio.load()
    }
    syncPlaying()
    refreshSettings()
  }
  syncPlaying()
  void api
    ?.getMusicFile()
    .then(setFile)
    .catch((err) => console.error('music file load failed', err))

  function buildSettings(panel: HTMLElement): Sync {
    const box = document.createElement('div')
    box.className = 'music-settings'
    const name = document.createElement('p')
    name.className = 'panel-note'
    const note = document.createElement('p')
    note.className = 'panel-note'
    note.textContent =
      '選んだ音源は、右上の音楽のボタンでループ再生します(mp3、m4a、aac、ogg、opus、wav、flac)。ボタンにカーソルを合わせると音量を変えられます。録画(Ctrl+F12)には音は入りません(動画の編集で、元の音源を重ねてください)。'
    const buttons = document.createElement('div')
    buttons.className = 'music-settings-buttons'
    const choose = document.createElement('button')
    choose.type = 'button'
    choose.textContent = '音源ファイルを選ぶ'
    const clear = document.createElement('button')
    clear.type = 'button'
    clear.textContent = '外す'
    buttons.append(choose, clear)
    const settingsStatus = document.createElement('p')
    settingsStatus.className = 'panel-note music-settings-status'
    settingsStatus.setAttribute('role', 'status')
    box.append(name, buttons, settingsStatus, note)
    panel.append(box)

    refreshSettings = () => {
      name.textContent = file ? `現在の音源: ${fileName(file)}` : '音源は選ばれていません。'
      name.title = file ?? ''
      clear.disabled = !file
      choose.disabled = !api
    }
    async function change(run: () => Promise<string | null | undefined>): Promise<void> {
      try {
        const next = await run()
        setStatus(settingsStatus, '')
        // ダイアログをキャンセルした
        if (next === undefined) return
        setFile(next)
      } catch (err) {
        setStatus(settingsStatus, `音源を変えられませんでした: ${err instanceof Error ? err.message : String(err)}`, true)
      }
    }
    choose.addEventListener('click', () => {
      if (!api) return
      void change(async () => (await api.chooseMusicFile()) ?? undefined)
    })
    clear.addEventListener('click', () => {
      if (!api) return
      void change(async () => {
        await api.clearMusicFile()
        return null
      })
    })
    refreshSettings()
    return () => refreshSettings()
  }

  return { buildSettings, syncVolume }
}
