// アプリの設定。設定ウインドウ(右上の歯車、または , キー)で変え、次の起動にも引き継ぐ。
// 設定ウインドウは、タブで分けたセクションに項目を並べる(weather-globe の設定ダイアログと同じ作り)。
// 項目を足すときは、AppSettings と DEFAULT_SETTINGS に足し、main.ts の setupSettings に 1 行足す。

import { addCheck, addChoice, addSlider, byId, type Sync } from './ui'

export interface AppSettings {
  /** 描画の回数の上限(1 秒あたり)。0 は制限なし(画面の更新に合わせる) */
  fpsLimit: number
  /** 描画の細かさの上限(画面の 1 画素あたりに描く画素の数の、縦横の倍率) */
  pixelRatio: number
  /** ウィンドウの中身の高さ(画面の表示倍率を掛けた見た目の大きさ、16:9)。起動時と選んだときに合わせる */
  windowSize: number
  /** 被写界深度で、1 画素あたりに拾う点の数(品質)。少ないほど軽い */
  dofSamples: number
  /** 左上に「性能」のパネル(fps、処理時間、描画の数)を出すか */
  showFps: boolean
  /** 機体のまわりの芝を、葉の 1 枚ずつまで描くか */
  grassBlades: boolean
  /** 芝の葉を描く距離(m)。カメラが見ている地面のまわり、この半径まで葉を描く */
  grassDistance: number
  /** 芝の倒れた向きと、見る向きの関係でつく縞の明暗の強さ */
  grassStripe: number
  /** 芝の倒れた向きと、太陽の向きの関係でつく縞の明暗の強さ */
  grassTilt: number
  /** 影を描く距離(m) */
  shadowDistance: number
  /** 影の段数(カスケードシャドウマップの段の数)。段ごとに影の地図を 1 枚使う */
  shadowCascades: number
  /** 影の地図の一辺(画素)。大きいほど影の縁が細かい */
  shadowMapSize: number
  /** 樹木を細かいモデルで描く距離(m)。その先は簡略モデル */
  treeDetailDistance: number
  /** 樹木をインポスター(絵を貼った板)に切り替える距離(m)。その手前は簡略モデル */
  treeImpostorDistance: number
  /** 木の葉が日の光を照り返して、きらめくようにするか */
  leafGlint: boolean
  /** 葉のきらめきの瞬く速さ(倍) */
  leafGlintSpeed: number
  /** 葉のきらめきの強さ(倍) */
  leafGlintStrength: number
  /** 逆光で、木の葉が日の光を透かして見える強さ(0 で透けない) */
  leafTranslucency: number
  /** 刈りカスの粒を描くか */
  clippings: boolean
  /** 倍速のとき、草木の揺れを何倍まで速くするか(1 は倍速をかけない) */
  swayTimeScale: number
  /** 画面の上の、操作の案内を出すか */
  showHint: boolean
  /** 録画(Ctrl+F12)の毎秒のコマ数(30 か 60) */
  recordingFps: number
  /** 録画にマウスポインタを写すか */
  recordingCursor: boolean
  /** 音楽の音量(0〜1。右上の音楽のボタンの音量バーで変える) */
  musicVolume: number
  /** 動作確認用: 刈った地面の法線マップを左上に出すか(次の起動には引き継がない) */
  showNormals: boolean
  /** 動作確認用: 法線マップの傾きを何倍に強調して見せるか */
  normalGain: number
  /**
   * 既定値の版。既定値を変えたとき、保存してある値が古い既定値のままなら新しい既定値に置き換えるために使う
   * (設定は全項目をまとめて保存するので、変えていない項目も古い既定値で残っている)。画面には出さない
   */
  defaultsVersion: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  fpsLimit: 60,
  pixelRatio: 2,
  windowSize: 1080,
  dofSamples: 80,
  showFps: true,
  grassBlades: true,
  grassDistance: 20,
  grassStripe: 0.18,
  grassTilt: 0.2,
  shadowDistance: 600,
  shadowCascades: 4,
  shadowMapSize: 2048,
  treeDetailDistance: 60,
  treeImpostorDistance: 400,
  leafGlint: true,
  leafGlintSpeed: 0.5,
  leafGlintStrength: 1,
  leafTranslucency: 1,
  clippings: true,
  swayTimeScale: 1,
  showHint: true,
  recordingFps: 60,
  recordingCursor: false,
  musicVolume: 0.5,
  showNormals: false,
  normalGain: 4,
  defaultsVersion: 4
}

/**
 * 既定値を変えた記録。保存してある版がこれより古く、値が以前の既定値のままなら、今の既定値に置き換える
 * (自分で選んだ値は残す)
 */
const DEFAULT_CHANGES: { version: number; key: keyof AppSettings; previous: number | boolean }[] = [
  // 版 2: 管制の視点などで遠くまで見渡すので、影を遠くまで落とす。近くの影が粗くならないよう段も増やす
  { version: 2, key: 'shadowDistance', previous: 220 },
  { version: 2, key: 'shadowCascades', previous: 3 },
  // 版 3: 描画 FPS の上限と録画のコマ数を、どちらも 60 にそろえる
  { version: 3, key: 'fpsLimit', previous: 0 },
  { version: 3, key: 'recordingFps', previous: 30 },
  // 版 4: 葉の透けに影を入れて光る葉が縁だけになったので、既定を標準の 1 倍にする
  { version: 4, key: 'leafTranslucency', previous: 0.5 }
]

const STORAGE_KEY = 'lawn-mower-settings'
/** 保存はするが、次の起動では戻さない項目(動作確認用の表示) */
const TRANSIENT_KEYS: (keyof AppSettings)[] = ['showNormals']
/** 以前は右の列の「芝」パネルにあった項目。設定に値が無ければ、パネルの保存(ui.ts)から引き継ぐ */
const LEGACY_PANEL_KEYS: Partial<Record<keyof AppSettings, string>> = {
  grassBlades: 'grass-fields/芝の葉',
  grassStripe: 'grass-fields/縞(視線)',
  grassTilt: 'grass-fields/縞(太陽)',
  normalGain: 'grass-fields/法線の強調'
}

/** 保存してある設定を読む。無い項目や型の合わない項目は、既定値にする */
export function loadSettings(): AppSettings {
  const settings = { ...DEFAULT_SETTINGS }
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>
    const legacy = JSON.parse(window.localStorage.getItem('lawn-mower-panels') ?? '{}') as Record<string, unknown>
    let migrated = false
    for (const [key, panelKey] of Object.entries(LEGACY_PANEL_KEYS)) {
      if (saved[key] !== undefined || !panelKey || legacy[panelKey] === undefined) continue
      saved[key] = legacy[panelKey]
      migrated = true
    }
    const savedVersion = typeof saved.defaultsVersion === 'number' ? saved.defaultsVersion : 1
    for (const change of DEFAULT_CHANGES) {
      if (savedVersion < change.version && saved[change.key] === change.previous) {
        delete saved[change.key]
        migrated = true
      }
    }
    delete saved.defaultsVersion
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
      if (TRANSIENT_KEYS.includes(key)) continue
      if (typeof saved[key] === typeof DEFAULT_SETTINGS[key]) {
        ;(settings as unknown as Record<string, unknown>)[key] = saved[key]
      }
    }
    // 引き継いだ値と、置き換えた既定値は、すぐ保存しておく(パネルの保存は、次に保存するとき芝の項目が抜ける)
    if (migrated || savedVersion < DEFAULT_SETTINGS.defaultsVersion) saveSettings(settings)
  } catch {
    // 読めないときは既定値のまま使う
  }
  return settings
}

export function saveSettings(settings: AppSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // 保存できなくても、動作は続ける
  }
}

type NumberKey = { [K in keyof AppSettings]: AppSettings[K] extends number ? K : never }[keyof AppSettings]
type BooleanKey = { [K in keyof AppSettings]: AppSettings[K] extends boolean ? K : never }[keyof AppSettings]

/** 設定ウインドウの 1 項目 */
export type SettingItem =
  | {
      type: 'choice'
      key: NumberKey
      label: string
      title: string
      options: { value: number; label: string }[]
    }
  | {
      type: 'slider'
      key: NumberKey
      label: string
      title: string
      min: number
      max: number
      step: number
      format: (value: number) => string
    }
  | { type: 'check'; key: BooleanKey; label: string; title: string }
  /** 決まった形に当てはまらない項目(音楽の音源の選択など)。中身を作り、画面を合わせ直す関数を返す */
  | { type: 'custom'; build: (panel: HTMLElement) => Sync }

export interface SettingSection {
  title: string
  items: SettingItem[]
}

/**
 * 設定ウインドウを作る。settings を書き換え、変わるたびに保存して onChange を呼ぶ。
 * toggle で開け閉めし、openTab で指定した見出しのタブを開く
 */
export function setupSettings(
  settings: AppSettings,
  sections: SettingSection[],
  onChange: (key: keyof AppSettings) => void
): { toggle: () => void; openTab: (title: string) => void } {
  const dialog = byId<HTMLDialogElement>('settings')
  const tabs = byId('settings-tabs')
  const body = byId('settings-body')
  const syncs: Sync[] = []
  const changed = (key: keyof AppSettings): void => {
    saveSettings(settings)
    onChange(key)
  }

  const buttons: HTMLButtonElement[] = []
  const panels: HTMLElement[] = []
  const select = (index: number): void => {
    buttons.forEach((button, i) => button.setAttribute('aria-selected', String(i === index)))
    panels.forEach((panel, i) => (panel.hidden = i !== index))
  }
  sections.forEach((section, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.role = 'tab'
    button.textContent = section.title
    button.addEventListener('click', () => select(index))
    tabs.append(button)
    buttons.push(button)

    const panel = document.createElement('div')
    panel.className = 'field-list'
    panel.role = 'tabpanel'
    for (const item of section.items) {
      if (item.type === 'custom') {
        syncs.push(item.build(panel))
      } else if (item.type === 'choice') {
        syncs.push(
          addChoice(
            panel,
            item.label,
            item.title,
            item.options,
            () => settings[item.key],
            (v) => {
              settings[item.key] = v
              changed(item.key)
            },
            DEFAULT_SETTINGS[item.key]
          )
        )
      } else if (item.type === 'slider') {
        syncs.push(
          addSlider(panel, {
            label: item.label,
            title: item.title,
            min: item.min,
            max: item.max,
            step: item.step,
            get: () => settings[item.key],
            set: (v) => {
              settings[item.key] = v
              changed(item.key)
            },
            format: item.format,
            defaultValue: () => DEFAULT_SETTINGS[item.key]
          })
        )
      } else {
        syncs.push(
          addCheck(
            panel,
            item.label,
            item.title,
            () => settings[item.key],
            (v) => {
              settings[item.key] = v
              changed(item.key)
            },
            DEFAULT_SETTINGS[item.key]
          )
        )
      }
    }
    body.append(panel)
    panels.push(panel)
  })
  select(0)

  byId('settings-reset-all').addEventListener('click', () => {
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
      ;(settings as unknown as Record<string, unknown>)[key] = DEFAULT_SETTINGS[key]
      onChange(key)
    }
    saveSettings(settings)
    for (const sync of syncs) sync()
  })

  const toggle = (): void => {
    if (dialog.open) dialog.close()
    else dialog.showModal()
  }
  const openTab = (title: string): void => {
    const index = sections.findIndex((section) => section.title === title)
    if (index >= 0) select(index)
    if (!dialog.open) dialog.showModal()
  }
  byId('open-settings').addEventListener('click', toggle)
  byId('close-settings').addEventListener('click', () => dialog.close())
  // ウインドウの外側を押したら閉じる
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return
    const r = dialog.getBoundingClientRect()
    const inside =
      e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
    if (!inside) dialog.close()
  })
  return { toggle, openTab }
}
