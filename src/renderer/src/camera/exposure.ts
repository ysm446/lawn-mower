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
}

export const DEFAULT_CAMERA_SETTINGS: CameraSettings = {
  sensorWidth: 36,
  focalLength: 35,
  fNumber: 5.6,
  shutterTime: 1 / 500,
  iso: 100,
  exposureCompensation: 0
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
