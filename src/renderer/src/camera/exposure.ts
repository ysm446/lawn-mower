// 物理カメラの計算。描画に依存しない。

export interface CameraSettings {
  /** センサーの幅(mm)。35 mm フルサイズは 36 */
  sensorWidth: number
  /** 焦点距離(mm) */
  focalLength: number
  /** 絞り(F 値) */
  fNumber: number
  /** シャッター速度(秒) */
  shutterTime: number
  /** ISO 感度 */
  iso: number
  /** 露出補正(EV)。正で明るくなる */
  exposureCompensation: number
  /** 自動露出。画面の明るさに合わせてシャッター速度を決める */
  autoExposure: boolean
  /** 被写界深度(ピントの合う範囲の外をぼかす) */
  depthOfField: boolean
  /** ミニチュア倍率。被写体を 1 / 倍率 の大きさの模型とみなして、ぼけを計算する */
  miniatureScale: number
  /** ティルト(度)。ピントの合う面を傾ける */
  tiltDeg: number
}

export const DEFAULT_CAMERA_SETTINGS: CameraSettings = {
  sensorWidth: 36,
  focalLength: 35,
  fNumber: 5.6,
  shutterTime: 1 / 500,
  iso: 100,
  exposureCompensation: 0,
  autoExposure: true,
  depthOfField: true,
  miniatureScale: 30,
  tiltDeg: 0
}

/** ISO 100 に換算した露出値 */
export function ev100(fNumber: number, shutterTime: number, iso: number): number {
  return Math.log2((fNumber * fNumber) / shutterTime) - Math.log2(iso / 100)
}

/**
 * シーンの輝度(cd/m²)に掛ける係数。
 * センサーが飽和する輝度を 1.0 に対応させる(飽和基準の感度)。
 */
export function exposureFromEv100(ev: number, compensation = 0): number {
  return Math.pow(2, compensation) / (1.2 * Math.pow(2, ev))
}

export function exposureFromSettings(s: CameraSettings): number {
  return exposureFromEv100(ev100(s.fNumber, s.shutterTime, s.iso), s.exposureCompensation)
}

/** 水平画角(ラジアン) */
export function horizontalFov(sensorWidth: number, focalLength: number): number {
  return 2 * Math.atan(sensorWidth / (2 * focalLength))
}

/** 反射光式の露出計の定数(cd/m²)。平均の輝度がこの基準で中間の明るさになる */
const METER_CONSTANT = 12.5

/** 平均の輝度(cd/m²)に対して、標準の明るさになる露出値(ISO 100 換算) */
export function ev100FromLuminance(luminance: number): number {
  return Math.log2((luminance * 100) / METER_CONSTANT)
}

/** 露出値(ISO 100 換算)になるシャッター速度(秒) */
export function shutterTimeForEv100(ev: number, fNumber: number, iso: number): number {
  return (fNumber * fNumber) / (Math.pow(2, ev) * (iso / 100))
}

/**
 * ぼけの直径(センサー上、mm)。薄いレンズの式による。
 * focusDistance はピントを合わせた距離、distance は被写体までの距離(m)。
 * scale はミニチュア倍率で、被写体が 1 / scale の大きさで、その分だけ近くにあるとみなす。
 */
export function blurDiameter(
  focalLength: number,
  fNumber: number,
  focusDistance: number,
  distance: number,
  scale = 1
): number {
  const f = focalLength / 1000
  const s = Math.max(focusDistance / scale, f * 1.5)
  const d = Math.max(distance / scale, 1e-4)
  return ((f * f * Math.abs(d - s)) / (fNumber * d * (s - f))) * 1000
}