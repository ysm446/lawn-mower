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
  parent.append(label, row)

  const show = (value: number): void => {
    const fill = ((value - spec.min) / (spec.max - spec.min)) * 100
    input.style.setProperty('--fill', `${Math.min(Math.max(fill, 0), 100)}%`)
    output.textContent = spec.format(value)
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
    set: (i) => set(stops[i]),
    format: (i) => format(stops[i])
  }
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
