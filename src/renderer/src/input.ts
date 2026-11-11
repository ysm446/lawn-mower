// キーボード入力。

import type { VehicleInput } from './sim/vehicle'

export class KeyboardInput {
  private readonly down = new Set<string>()
  private readonly handlers = new Map<string, () => void>()

  constructor(target: Window) {
    target.addEventListener('keydown', (e) => {
      if (e.repeat) return
      this.down.add(e.code)
      const handler = this.handlers.get(e.code)
      if (handler) {
        handler()
        e.preventDefault()
      }
    })
    target.addEventListener('keyup', (e) => this.down.delete(e.code))
    target.addEventListener('blur', () => this.down.clear())
  }

  /** キーを押した瞬間に呼ぶ処理を登録する */
  onPress(code: string, handler: () => void): void {
    this.handlers.set(code, handler)
  }

  /** キーが押されているか */
  isDown(code: string): boolean {
    return this.down.has(code)
  }

  /** positive のどれかが押されていれば 1、negative のどれかなら -1。両方または無しなら 0 */
  axis(positive: string[], negative: string[]): number {
    const p = positive.some((c) => this.down.has(c)) ? 1 : 0
    const n = negative.some((c) => this.down.has(c)) ? 1 : 0
    return p - n
  }

  /** 運転の入力。letters が false のときは、W / A / S / D を使わず矢印キーだけで運転する */
  read(letters = true): VehicleInput {
    if (!letters) {
      return {
        throttle: this.axis(['ArrowUp'], ['ArrowDown']),
        steer: this.axis(['ArrowLeft'], ['ArrowRight'])
      }
    }
    return {
      throttle: this.axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']),
      steer: this.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight'])
    }
  }
}
