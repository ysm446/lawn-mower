// weather-globe の custom-select.ts を移植したもの。
// OS 標準の選択の一覧の代わりに、アプリのデザインの一覧を出す。
// 元の <select> は値と change イベントの持ち主として残し、見えなくする。各所のコードは今までどおり
// select.value を読み書きし、change を受ければよい (値を書くと、見えているボタンの文字も変わる)
const EDGE = 8
const GAP = 4

const CHEVRON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>'

let openClose: (() => void) | null = null  // 開いている一覧を閉じる。一度に開くのは 1 つだけ

function visibleOptions(select: HTMLSelectElement): HTMLOptionElement[] {
  return Array.from(select.options).filter((option) => !option.hidden && !option.disabled)
}

/** select を、アプリのデザインの一覧を出すボタンに置き換える */
export function enhanceSelect(select: HTMLSelectElement): void {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'app-select'
  button.setAttribute('aria-haspopup', 'listbox')
  button.setAttribute('aria-expanded', 'false')
  if (select.id) button.dataset.for = select.id // 設定画面の説明のポップアップがラベルを探すのに使う
  const text = document.createElement('span')
  text.className = 'app-select-text'
  button.append(text)
  button.insertAdjacentHTML('beforeend', CHEVRON)
  select.classList.add('native-select')
  select.tabIndex = -1
  select.setAttribute('aria-hidden', 'true')
  select.after(button)

  const label = select.id ? document.querySelector<HTMLLabelElement>(`label[for="${select.id}"]`) : null
  const name = select.getAttribute('aria-label') ?? label?.textContent?.trim() ?? ''
  // ラベルを押したときは、隠した select ではなくボタンへ移る
  label?.addEventListener('click', (event) => {
    event.preventDefault()
    button.focus()
  })

  function sync(): void {
    text.textContent = select.selectedOptions[0]?.textContent ?? ''
    button.disabled = select.disabled
    button.setAttribute('aria-label', name ? `${name}: ${text.textContent}` : text.textContent)
  }

  // 値を書いても select はイベントを出さないので、書いたときに表示を合わせる
  for (const key of ['value', 'selectedIndex'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, key)
    if (!descriptor?.get || !descriptor.set) continue
    Object.defineProperty(select, key, {
      configurable: true,
      get() {
        return descriptor.get!.call(this)
      },
      set(next) {
        descriptor.set!.call(this, next)
        sync()
      }
    })
  }
  new MutationObserver(sync).observe(select, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['disabled', 'hidden', 'selected']
  })
  select.addEventListener('change', sync)

  function choose(option: HTMLOptionElement): void {
    if (option.selected) return
    select.value = option.value
    select.dispatchEvent(new Event('input', { bubbles: true }))
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function open(): void {
    openClose?.()
    const options = visibleOptions(select)
    if (options.length === 0) return
    const list = document.createElement('div')
    list.className = 'app-select-list'
    list.setAttribute('role', 'listbox')
    if (name) list.setAttribute('aria-label', name)
    let active = Math.max(0, options.findIndex((option) => option.selected))
    const items = options.map((option, index) => {
      const item = document.createElement('div')
      item.className = 'app-select-option'
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', String(option.selected))
      item.textContent = option.textContent
      item.addEventListener('mousemove', () => setActive(index))
      item.addEventListener('click', () => {
        choose(option)
        close()
        button.focus()
      })
      return item
    })
    list.append(...items)

    function setActive(index: number): void {
      items[active]?.classList.remove('active')
      active = Math.min(Math.max(index, 0), items.length - 1)
      items[active].classList.add('active')
    }
    setActive(active)

    // 設定画面などのモーダルは最前面の層にあるので、その中に置かないと隠れる
    ;(button.closest('dialog[open]') ?? document.body).append(list)
    const anchor = button.getBoundingClientRect()
    list.style.minWidth = `${Math.round(anchor.width)}px`
    const size = list.getBoundingClientRect()
    const spaceBelow = window.innerHeight - anchor.bottom - GAP - EDGE
    const spaceAbove = anchor.top - GAP - EDGE
    const downward = size.height <= spaceBelow || spaceBelow >= spaceAbove
    list.style.maxHeight = `${Math.floor(downward ? spaceBelow : spaceAbove)}px`
    const height = list.getBoundingClientRect().height
    const left = Math.min(Math.max(anchor.left, EDGE), window.innerWidth - size.width - EDGE)
    list.style.left = `${Math.round(left)}px`
    list.style.top = `${Math.round(downward ? anchor.bottom + GAP : anchor.top - GAP - height)}px`
    items[active].scrollIntoView({ block: 'nearest' })
    button.setAttribute('aria-expanded', 'true')
    button.classList.add('open')

    const onKey = (event: KeyboardEvent): void => {
      const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 5, PageUp: -5 }[event.key]
      if (step !== undefined) setActive(active + step)
      else if (event.key === 'Home') setActive(0)
      else if (event.key === 'End') setActive(items.length - 1)
      else if (event.key === 'Enter') {
        choose(options[active])
        close()
      } else if (event.key === ' ') {
        // ボタンは Space を離したときに押されるので、選ぶのも離したとき (onKeyUp) にする。押した時点で閉じると、離したときにまた開く
      } else if (event.key === 'Escape' || event.key === 'Tab') {
        close()
        if (event.key === 'Tab') return  // Tab は次の項目へ移るのに使う
      } else return
      event.preventDefault()
      event.stopPropagation()
      items[active]?.scrollIntoView({ block: 'nearest' })
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key !== ' ') return
      event.preventDefault()
      event.stopPropagation()
      choose(options[active])
      close()
    }
    // Esc で一覧を閉じたとき、設定画面まで閉じないようにする
    const onCancel = (event: Event): void => event.preventDefault()
    const onOutside = (event: Event): void => {
      if (!list.contains(event.target as Node) && !button.contains(event.target as Node)) close()
    }
    const onScroll = (event: Event): void => {
      if (!list.contains(event.target as Node)) close()
    }

    function close(): void {
      list.remove()
      button.setAttribute('aria-expanded', 'false')
      button.classList.remove('open')
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('keyup', onKeyUp, true)
      document.removeEventListener('cancel', onCancel, true)
      document.removeEventListener('mousedown', onOutside, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      openClose = null
    }
    openClose = close
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('keyup', onKeyUp, true)
    document.addEventListener('cancel', onCancel, true)
    document.addEventListener('mousedown', onOutside, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    // 設定画面を閉じたときも一緒に閉じる
    button.closest('dialog')?.addEventListener('close', close, { once: true })
  }

  button.addEventListener('click', () => {
    if (button.classList.contains('open')) openClose?.()
    else open()
  })
  // 閉じたままでも、上下の矢印キーで前後の候補に切り替えられる (OS の select と同じ)
  button.addEventListener('keydown', (event) => {
    if (button.classList.contains('open')) return
    if (event.key === 'ArrowDown' && event.altKey) {
      event.preventDefault()
      open()
      return
    }
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
    if (step === undefined) return
    event.preventDefault()
    const options = visibleOptions(select)
    const index = options.findIndex((option) => option.selected)
    const next = options[Math.min(Math.max(index + step, 0), options.length - 1)]
    if (next) choose(next)
  })

  sync()
}

export function initCustomSelects(root: ParentNode = document): void {
  for (const select of Array.from(root.querySelectorAll<HTMLSelectElement>('select:not(.native-select)'))) {
    enhanceSelect(select)
  }
}
