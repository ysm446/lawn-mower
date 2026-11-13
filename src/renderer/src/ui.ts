// UI の部品。見た目は style.css、配置は index.html にあり、ここは値のやり取りを受け持つ。
// 各部品は「画面の値を現在の設定に合わせ直す関数」を返す。キー操作などで設定が変わったら呼ぶ。

import { enhanceSelect } from './customSelect'

export type Sync = () => void

export function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`#${id} が見つからない`)
  return el as T
}

let fieldSerial = 0

// ------------------------------------------------ 右の列のパネルの値の保存
// 右の列(#right-stack)のスライダーとチェックは、作ったときに自動で登録し、値を保存して次の起動で戻す。
// 設定ウインドウの項目は settings.ts が別に保存するので、ここでは扱わない

const PANEL_STORAGE_KEY = 'lawn-mower-panels'

interface PanelValue {
  key: string
  get: () => unknown
  set: (value: unknown) => void
  /** 戻すかどうか(戻すときに判断する)。保存はいつもする */
  restore: () => boolean
}

const panelValues: PanelValue[] = []
let saveTimer = 0
/** 保存を有効にしたか(restorePanelValues で有効にする) */
let persistEnabled = false

/** パネルの値を保存しない(false)、または戻す条件(関数) */
export type Persist = boolean | (() => boolean)

function registerPanelValue(
  parent: HTMLElement,
  label: string,
  get: () => unknown,
  set: (value: unknown) => void,
  persist: Persist | undefined
): void {
  if (persist === false || !parent.closest('#right-stack')) return
  panelValues.push({
    key: `${parent.id}/${label}`,
    get,
    set,
    restore: typeof persist === 'function' ? persist : () => true
  })
}

/**
 * 既定値を変えた記録。保存してある版(`__defaultsVersion`)がこれより古く、値が以前の既定値のままなら、
 * 戻さずに今の既定値を使う(パネルの値は全項目をまとめて保存するので、触っていない項目も古い既定値で残っている)。
 * 鍵は「入れ物の id / ラベル」。既定値を変えたら、ここに足す
 */
const PANEL_DEFAULT_CHANGES: { version: number; key: string; previous: unknown }[] = [
  // 版 2: 遠くがぼやけすぎるので、霞を薄くする(3 → 1)
  { version: 2, key: 'light-fields/霞', previous: 3 }
]
const PANEL_DEFAULTS_VERSION = Math.max(1, ...PANEL_DEFAULT_CHANGES.map((change) => change.version))
const VERSION_KEY = '__defaultsVersion'

/** 右の列のパネルの値を保存する */
export function savePanelValues(): void {
  window.clearTimeout(saveTimer)
  if (!persistEnabled) return
  const values: Record<string, unknown> = { [VERSION_KEY]: PANEL_DEFAULTS_VERSION }
  for (const item of panelValues) values[item.key] = item.get()
  try {
    window.localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(values))
  } catch {
    // 保存できなくても、動作は続ける
  }
}

/** 操作で値が変わったとき。続けて動かしている間は、まとめて少し後に保存する */
function panelValueChanged(): void {
  if (!persistEnabled) return
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(savePanelValues, 500)
}

/**
 * 保存しておいた右の列のパネルの値を戻す。部品をすべて作ったあとに 1 回呼ぶ。
 * 部品を作った順に、その部品の set を通して戻す(値が変わったときと同じ処理が走る)。
 * 型の合わない値は無視する。閉じるときにも保存するよう登録する
 */
export function restorePanelValues(): void {
  persistEnabled = true
  let saved: Record<string, unknown> = {}
  try {
    saved = JSON.parse(window.localStorage.getItem(PANEL_STORAGE_KEY) ?? '{}') as Record<string, unknown>
  } catch {
    saved = {}
  }
  const savedVersion = typeof saved[VERSION_KEY] === 'number' ? (saved[VERSION_KEY] as number) : 1
  for (const change of PANEL_DEFAULT_CHANGES) {
    if (savedVersion < change.version && saved[change.key] === change.previous) delete saved[change.key]
  }
  for (const item of panelValues) {
    const value = saved[item.key]
    if (value === undefined || typeof value !== typeof item.get() || !item.restore()) continue
    item.set(value)
  }
  // 既定値を置き換えたときは、すぐ保存しておく(次の起動で、また古い値として扱わないように)
  if (savedVersion < PANEL_DEFAULTS_VERSION) savePanelValues()
  // 太陽の向きのドラッグなど、パネルの外から変えた値も、閉じるときに保存する
  window.addEventListener('beforeunload', savePanelValues)
}

const FOLD_STORAGE_KEY = 'lawn-mower-panel-folds'

/**
 * 右の列のパネルと左上の「状態」の開閉を記録し、次の起動で同じ開き方に戻す。
 * 鍵は見出しの文字(見出しに値を添えるパネルは data-fold)。記録の無いパネル(初めての起動、新しく足したパネル)は index.html の open のまま
 */
export function rememberPanelFolds(): void {
  const folds = [...document.querySelectorAll<HTMLDetailsElement>('#right-stack .panel-fold, #top-left .panel-fold')]
  const keyOf = (fold: HTMLDetailsElement): string =>
    fold.dataset.fold ?? fold.querySelector('summary')?.textContent?.trim() ?? ''
  let saved: Record<string, unknown> = {}
  try {
    saved = JSON.parse(window.localStorage.getItem(FOLD_STORAGE_KEY) ?? '{}') as Record<string, unknown>
  } catch {
    saved = {}
  }
  for (const fold of folds) {
    const open = saved[keyOf(fold)]
    if (typeof open === 'boolean') fold.open = open
    fold.addEventListener('toggle', () => {
      const values: Record<string, boolean> = {}
      for (const f of folds) values[keyOf(f)] = f.open
      try {
        window.localStorage.setItem(FOLD_STORAGE_KEY, JSON.stringify(values))
      } catch {
        // 保存できなくても、動作は続ける
      }
    })
  }
}

export interface SliderSpec {
  label: string
  title?: string
  min: number
  max: number
  step: number
  get: () => number
  set: (value: number) => void
  format: (value: number) => string
  /** 既定値。省くと、作った時点の値を既定値にする。状況で変わるものは関数で渡す */
  defaultValue?: () => number
  /** 右の列のパネルで、値を保存して次の起動で戻すか(既定は保存する)。関数なら、戻すときの条件 */
  persist?: Persist
}

const RESET_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>'

/** 「既定に戻す」ボタン。値が既定値のときは押せない(薄く表示する) */
function resetButton(label: string, onReset: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'reset-button'
  button.title = '既定に戻す'
  button.setAttribute('aria-label', `${label}を既定に戻す`)
  button.innerHTML = RESET_ICON
  button.addEventListener('click', () => {
    onReset()
    button.blur() // Space などのキー操作がボタンに取られないようにする
  })
  return button
}

/** ラベル、スライダー、値の表示を 1 行として追加する */
export function addSlider(parent: HTMLElement, spec: SliderSpec): Sync {
  const id = `field-${fieldSerial++}`
  const label = document.createElement('label')
  label.htmlFor = id
  label.textContent = spec.label
  if (spec.title) label.title = spec.title

  const row = document.createElement('div')
  row.className = 'range-row'
  if (spec.title) row.title = spec.title
  const input = document.createElement('input')
  input.id = id
  input.type = 'range'
  input.min = String(spec.min)
  input.max = String(spec.max)
  input.step = String(spec.step)
  const output = document.createElement('output')
  output.htmlFor.add(id)
  row.append(input, output)
  const initial = spec.get()
  const defaultValue = spec.defaultValue ?? (() => initial)
  const reset = resetButton(spec.label, () => {
    spec.set(defaultValue())
    sync()
    panelValueChanged()
  })
  parent.append(label, row, reset)
  registerPanelValue(parent, spec.label, spec.get, (v) => spec.set(v as number), spec.persist)

  const show = (value: number): void => {
    const fill = ((value - spec.min) / (spec.max - spec.min)) * 100
    input.style.setProperty('--fill', `${Math.min(Math.max(fill, 0), 100)}%`)
    output.textContent = spec.format(value)
    reset.disabled = Math.abs(value - defaultValue()) < spec.step / 2
  }
  input.addEventListener('input', () => {
    spec.set(Number(input.value))
    show(Number(input.value))
    panelValueChanged()
  })
  const sync = (): void => {
    const value = spec.get()
    input.value = String(value)
    show(value)
  }
  sync()
  return sync
}

/** 決まった段(絞りやシャッター速度など)から選ぶスライダー */
export function stopsSlider(
  label: string,
  stops: number[],
  get: () => number,
  set: (value: number) => void,
  format: (value: number) => string,
  title?: string
): SliderSpec {
  const nearest = (value: number): number => {
    let best = 0
    for (let i = 1; i < stops.length; i++) {
      if (Math.abs(Math.log(stops[i] / value)) < Math.abs(Math.log(stops[best] / value))) best = i
    }
    return best
  }
  return {
    label,
    title,
    min: 0,
    max: stops.length - 1,
    step: 1,
    get: () => nearest(get()),
    set: (i) => set(stops[Math.round(i)]),
    format: (i) => format(stops[i])
  }
}

/** チェックボックスの 1 行を追加する */
export function addCheck(
  parent: HTMLElement,
  label: string,
  title: string,
  get: () => boolean,
  set: (value: boolean) => void,
  defaultValue?: boolean,
  /** 右の列のパネルで、値を保存して次の起動で戻すか(既定は保存する)。関数なら、戻すときの条件 */
  persist?: Persist
): Sync {
  const row = document.createElement('label')
  row.className = 'check-row'
  row.title = title
  const input = document.createElement('input')
  input.type = 'checkbox'
  row.append(input, label)
  // 既定値。省くと、作った時点の値を既定値にする
  const initial = defaultValue ?? get()
  const reset = resetButton(label, () => {
    set(initial)
    sync()
    panelValueChanged()
  })
  parent.append(row, reset)
  registerPanelValue(parent, label, get, (v) => set(v as boolean), persist)
  input.addEventListener('change', () => {
    set(input.checked)
    reset.disabled = input.checked === initial
    input.blur() // Space などのキー操作がチェックに取られないようにする
    panelValueChanged()
  })
  const sync = (): void => {
    input.checked = get()
    reset.disabled = input.checked === initial
  }
  sync()
  return sync
}

/** いくつかの選択肢から 1 つを選ぶ行(ラベル、横に並んだボタン、既定に戻すボタン) */
export function addChoice<T>(
  parent: HTMLElement,
  label: string,
  title: string,
  options: SwitchOption<T>[],
  get: () => T,
  set: (value: T) => void,
  defaultValue: T
): Sync {
  const name = document.createElement('label')
  name.textContent = label
  name.title = title
  const group = document.createElement('div')
  group.className = 'switch'
  group.role = 'group'
  group.title = title
  group.setAttribute('aria-label', label)
  const reset = resetButton(label, () => {
    set(defaultValue)
    sync()
  })
  parent.append(name, group, reset)
  const syncButtons = addSwitch(group, options, get, (value) => {
    set(value)
    reset.disabled = value === defaultValue
  })
  const sync = (): void => {
    syncButtons()
    reset.disabled = get() === defaultValue
  }
  sync()
  return sync
}

/**
 * プルダウンから 1 つを選ぶ行(ラベル、選択の欄、既定に戻すボタン)。
 * 選択の欄は weather-globe と同じ見た目の一覧を出す(customSelect.ts)。既定値は作った時点の値
 */
export function addSelect<T extends string>(
  parent: HTMLElement,
  label: string,
  title: string,
  options: SwitchOption<T>[],
  get: () => T,
  set: (value: T) => void,
  /** 右の列のパネルで、値を保存して次の起動で戻すか(既定は保存する)。関数なら、戻すときの条件 */
  persist?: Persist
): Sync {
  const id = `field-${fieldSerial++}`
  const name = document.createElement('label')
  name.htmlFor = id
  name.textContent = label
  name.title = title
  const cell = document.createElement('div')
  cell.className = 'select-cell'
  cell.title = title
  const select = document.createElement('select')
  select.id = id
  for (const option of options) {
    const item = document.createElement('option')
    item.value = option.value
    item.textContent = option.label
    select.append(item)
  }
  cell.append(select)
  const initial = get()
  const reset = resetButton(label, () => {
    set(initial)
    sync()
    panelValueChanged()
  })
  parent.append(name, cell, reset)
  enhanceSelect(select)
  const valid = (value: unknown): value is T => options.some((option) => option.value === value)
  registerPanelValue(
    parent,
    label,
    get,
    (v) => {
      if (valid(v)) set(v)
    },
    persist
  )
  select.addEventListener('change', () => {
    if (!valid(select.value)) return
    set(select.value)
    reset.disabled = select.value === initial
    // Space などのキー操作が選択の欄に取られないようにする(一覧を閉じるとフォーカスが戻るので、その後で外す)
    window.setTimeout(() => (cell.querySelector('.app-select') as HTMLElement | null)?.blur())
    panelValueChanged()
  })
  const sync = (): void => {
    select.value = get()
    reset.disabled = select.value === initial
  }
  sync()
  return sync
}

export interface SwitchOption<T> {
  value: T
  label: string
  title?: string
}

/** 横に並んだボタンから 1 つを選ぶ切り替え */
export function addSwitch<T>(
  parent: HTMLElement,
  options: SwitchOption<T>[],
  get: () => T,
  set: (value: T) => void
): Sync {
  const buttons = options.map((option) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = option.label
    if (option.title) button.title = option.title
    button.addEventListener('click', () => {
      set(option.value)
      sync()
      button.blur() // Space などのキー操作がボタンに取られないようにする
    })
    parent.append(button)
    return button
  })
  const sync = (): void => {
    const current = get()
    buttons.forEach((button, i) => {
      button.setAttribute('aria-pressed', String(options[i].value === current))
    })
  }
  sync()
  return sync
}

/** 項目名と値を並べた表示。返す関数に値を渡すと、変わった所だけ書き換える */
export function addReadout<K extends string>(
  parent: HTMLElement,
  items: Record<K, string>
): (values: Record<K, string>) => void {
  const cells = {} as Record<K, HTMLElement>
  const shown = {} as Record<K, string>
  for (const key of Object.keys(items) as K[]) {
    const row = document.createElement('div')
    const dt = document.createElement('dt')
    dt.textContent = items[key]
    const dd = document.createElement('dd')
    row.append(dt, dd)
    parent.append(row)
    cells[key] = dd
  }
  return (values) => {
    for (const key of Object.keys(values) as K[]) {
      if (shown[key] !== values[key]) {
        shown[key] = values[key]
        cells[key].textContent = values[key]
      }
    }
  }
}

export interface HelpSection {
  title: string
  items: { keys: string[]; text: string }[]
}

/** 操作の一覧のダイアログを組み立てる。返す関数で開閉する */
export function setupHelp(sections: HelpSection[]): () => void {
  const dialog = byId<HTMLDialogElement>('key-help')
  const body = byId('key-help-body')
  for (const section of sections) {
    const el = document.createElement('section')
    const h3 = document.createElement('h3')
    h3.textContent = section.title
    const dl = document.createElement('dl')
    for (const item of section.items) {
      const dt = document.createElement('dt')
      item.keys.forEach((key, i) => {
        if (i > 0) dt.append(' ')
        const kbd = document.createElement('kbd')
        kbd.textContent = key
        dt.append(kbd)
      })
      const dd = document.createElement('dd')
      dd.textContent = item.text
      dl.append(dt, dd)
    }
    el.append(h3, dl)
    body.append(el)
  }

  const toggle = (): void => {
    if (dialog.open) dialog.close()
    else dialog.showModal()
  }
  byId('open-help').addEventListener('click', toggle)
  byId('close-help').addEventListener('click', () => dialog.close())
  // ダイアログの外側を押したら閉じる
  dialog.addEventListener('click', (e) => {
    const r = dialog.getBoundingClientRect()
    const inside =
      e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
    if (!inside) dialog.close()
  })
  return toggle
}

const EYE_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>' +
  '<path class="eye-off" d="M4 4l16 16"/></svg>'

/**
 * パネルの見出しの行に、表示・非表示を切り替えるボタン(目のアイコン)を置く。
 * パネルを閉じたままでも押せる。見出しを押すと、これまでどおりパネルが開いて設定が出る。
 * ボタンは見出し(summary)の中には入れず、パネルの枠に重ねて置く(見出しの中に置くと、押したときにパネルも開閉する)
 */
export function addPanelToggle(
  fold: HTMLElement,
  label: string,
  key: string,
  get: () => boolean,
  set: (value: boolean) => void
): Sync {
  const panel = fold.parentElement as HTMLElement
  panel.classList.add('has-toggle')
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'panel-toggle'
  button.innerHTML = EYE_ICON
  button.addEventListener('click', () => {
    set(!get())
    sync()
    button.blur() // Space などのキー操作がボタンに取られないようにする
  })
  panel.append(button)
  const sync = (): void => {
    const on = get()
    button.setAttribute('aria-pressed', String(on))
    const text = on ? `${label}を隠す(${key})` : `${label}を表示する(${key})`
    button.title = text
    button.setAttribute('aria-label', text)
  }
  sync()
  return sync
}
