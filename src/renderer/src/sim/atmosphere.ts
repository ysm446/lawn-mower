// 大気の定数と、太陽の光が大気を抜けてくる割合の計算。描画に依存しない。
// モデルは terrain-graph(D:\GitHub\terrain-graph の shaders/AtmosphereScattering.hlsli)と同じで、
// レイリー散乱(空気の分子)とミー散乱(霞の粒)を、高さとともに指数で薄くなる 2 つの層として扱う。
// 空と霞の描画(render/atmosphere.ts)も、ここの定数を使う。値を変えるときは両方を確かめる。

/** 地球の半径(m)と、大気の上端の半径(m) */
export const EARTH_RADIUS = 6360e3
export const ATMOSPHERE_RADIUS = 6420e3
/** レイリー散乱とミー散乱の、密度が 1/e になる高さ(m) */
export const RAYLEIGH_HEIGHT = 7994
export const MIE_HEIGHT = 1200
/** 地表でのレイリー散乱の係数(1/m)。赤、緑、青。青ほどよく散る */
export const RAYLEIGH_BETA: readonly [number, number, number] = [5.802e-6, 13.558e-6, 33.1e-6]
/** 地表でのミー散乱の係数(1/m)。霞の濃さ 1 のときの値 */
export const MIE_BETA = 21e-6
/** ミー散乱に対する消散(散乱と吸収の合計)の比 */
export const MIE_EXTINCTION = 1.1
/** 大気の外での太陽の照度(lx) */
export const SOLAR_ILLUMINANCE = 120000
/** 太陽の光路を積分する点の数 */
const SUN_STEPS = 32

/**
 * 高さ observerHeight(m)の地点から、高度 elevationDeg(度)の太陽を見たときの、光の透過率(赤、緑、青)。
 * haze は霞の濃さ(ミー散乱の倍率)。太陽が地平線の下で地球に隠れるときは 0。
 */
export function sunTransmittance(
  elevationDeg: number,
  haze: number,
  observerHeight = 1
): [number, number, number] {
  const elevation = (elevationDeg * Math.PI) / 180
  const dirX = Math.cos(elevation)
  const dirY = Math.sin(elevation)
  const originY = EARTH_RADIUS + Math.max(observerHeight, 1)
  // 大気の上端までの距離。原点は地球の中心
  const b = originY * dirY
  const reach = (radius: number): number => b * b - (originY - radius) * (originY + radius)
  const top = reach(ATMOSPHERE_RADIUS)
  if (top < 0) return [0, 0, 0]
  const far = -b + Math.sqrt(top)
  // 地球に当たる(太陽が地平線の下にある)なら、光は届かない
  const ground = reach(EARTH_RADIUS)
  if (ground >= 0 && -b - Math.sqrt(ground) > 0) return [0, 0, 0]

  let opticalR = 0
  let opticalM = 0
  for (let i = 0; i < SUN_STEPS; i++) {
    // 空気の濃い地表の近くに点を集める
    const start = far * (i / SUN_STEPS) ** 2
    const end = far * ((i + 1) / SUN_STEPS) ** 2
    const t = (start + end) / 2
    const height = Math.hypot(dirX * t, originY + dirY * t) - EARTH_RADIUS
    opticalR += Math.exp(-height / RAYLEIGH_HEIGHT) * (end - start)
    opticalM += Math.exp(-height / MIE_HEIGHT) * (end - start)
  }
  const mie = MIE_BETA * haze * MIE_EXTINCTION * opticalM
  return [
    Math.exp(-RAYLEIGH_BETA[0] * opticalR - mie),
    Math.exp(-RAYLEIGH_BETA[1] * opticalR - mie),
    Math.exp(-RAYLEIGH_BETA[2] * opticalR - mie)
  ]
}
