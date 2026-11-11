// 時刻から太陽の向きを求める。タイムラプスで、時間とともに太陽を動かすのに使う。
// 場所と季節は固定(北緯 36°、初夏)。時刻は太陽が真南に来る時を 12 時とする(地方真太陽時)。

const DEG = Math.PI / 180

/** 緯度(度)。関東のあたり */
export const LATITUDE_DEG = 36
/** 太陽の赤緯(度)。5 月下旬と 7 月下旬にあたる */
export const DECLINATION_DEG = 20
/**
 * 真北の向き。アプリの方位(+Z から +X へ測る)で表す。
 * 朝 7 時半の太陽が、時刻で動かす前の既定の向き(方位 125°)に来るように決めてある。
 */
export const NORTH_AZIMUTH_DEG = 210
/** 昼として扱う太陽の高度の下限(度)。これより低い時間帯(夜)は飛ばす */
export const MIN_SUN_ELEVATION_DEG = 4

export interface SunAngles {
  /** 高度(度) */
  elevation: number
  /** 方位(度)。アプリの座標で、+Z から +X へ測る。0 以上 360 未満 */
  azimuth: number
}

/** 時刻(時。12 が南中)での太陽の高度と方位 */
export function sunAngles(hour: number): SunAngles {
  const lat = LATITUDE_DEG * DEG
  const dec = DECLINATION_DEG * DEG
  const hourAngle = (hour - 12) * 15 * DEG
  const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(hourAngle)
  const elevation = Math.asin(Math.min(Math.max(sinEl, -1), 1))
  // 北から東回りに測った方位
  const east = -Math.cos(dec) * Math.sin(hourAngle)
  const north = Math.cos(lat) * Math.sin(dec) - Math.sin(lat) * Math.cos(dec) * Math.cos(hourAngle)
  const compass = Math.atan2(east, north) / DEG
  // アプリの方位は、上から見て方角とは逆回りに増える
  const azimuth = (((NORTH_AZIMUTH_DEG - compass) % 360) + 360) % 360
  return { elevation: elevation / DEG, azimuth }
}

/** 太陽の高度が minElevation(度)以上になる時間帯。日の出側と日の入り側の時刻(時)を返す */
export function daylightHours(minElevation = MIN_SUN_ELEVATION_DEG): { start: number; end: number } {
  const lat = LATITUDE_DEG * DEG
  const dec = DECLINATION_DEG * DEG
  const cosH =
    (Math.sin(minElevation * DEG) - Math.sin(lat) * Math.sin(dec)) / (Math.cos(lat) * Math.cos(dec))
  const half = Math.acos(Math.min(Math.max(cosH, -1), 1)) / DEG / 15
  return { start: 12 - half, end: 12 + half }
}

/**
 * 時刻を seconds 秒だけ進める。日の入りを過ぎたら、次の日の出へ飛ぶ(夜は飛ばす)。
 * 昼の時間帯より前の時刻を渡したときも、日の出に揃える。
 */
export function advanceHour(hour: number, seconds: number): number {
  const { start, end } = daylightHours()
  const length = end - start
  const offset = hour - start + seconds / 3600
  return start + (((offset % length) + length) % length)
}

/** 時刻を「7:05」の形にする */
export function formatHour(hour: number): string {
  const minutes = Math.round(hour * 60)
  const h = Math.floor(minutes / 60) % 24
  return `${h}:${(minutes % 60).toString().padStart(2, '0')}`
}
