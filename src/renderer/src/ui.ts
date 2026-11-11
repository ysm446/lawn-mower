// UI の部品。見た目は style.css、配置は index.html にあり、ここは値のやり取りを受け持つ。
// 各部品は「画面の値を現在の設定に合わせ直す関数」を返す。キー操作などで設定が変わったら呼ぶ。

export type Sync = () => void

export function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`#${id} が見つからない`)
  return el as T
}

let fieldSerial = 0

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
  })
  parent.append(label, row, reset)

  const show = (value: number): void => {
    const fill = ((value - spec.min) / (spec.max - spec.min)) * 100
    input.style.setProperty('--fill', `${Math.min(Math.max(fill, 0), 100)}%`)
    output.textContent = spec.format(value)
    reset.disabled = Math.abs(value - defaultValue()) < spec.step / 2
  }
  input.addEventListener('input', () => {
    spec.set(Number(input.value))
    show(Number(input.value))
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
  defaultValue?: boolean
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
  })
  parent.append(row, reset)
  input.addEventListener('change', () => {
    set(input.checked)
    reset.disabled = input.checked === initial
    input.blur() // Space などのキー操作がチェックに取られないようにする
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
