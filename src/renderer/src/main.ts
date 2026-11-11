import './style.css'
import {
  ACESFilmicToneMapping,
  HalfFloatType,
  PCFShadowMap,
  Scene,
  WebGLRenderTarget,
  WebGLRenderer
} from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { KeyboardInput } from './input'
import { CAMERA_MODES, CAMERA_MODE_LABELS, CameraRig, type CameraMode } from './render/cameraRig'
import { createGround } from './render/ground'
import { Lighting } from './render/lighting'
import { MowMap } from './render/mowMap'
import { MowerModel } from './render/mowerModel'
import { ev100 } from './camera/exposure'
import { CoverageGrid } from './sim/coverage'
import { LineDriver } from './sim/lineDriver'
import {
  FAIRWAY_MOWER,
  createVehicleState,
  deckSegment,
  stepVehicle,
  type DeckSegment
} from './sim/vehicle'
import { addReadout, addSlider, addSwitch, byId, setupHelp, stopsSlider, type Sync } from './ui'

// 単位はすべて実寸(1 = 1 m)
const FIELD_SIZE = 256
const FIELD_ORIGIN = -FIELD_SIZE / 2
const GROUND_EXTENT = 5000
const MAX_GRASS_HEIGHT = 0.2
const UNCUT_HEIGHT = 0.07
const SIM_DT = 1 / 120
const MAX_STEPS_PER_FRAME = 600
const TIME_SCALES = [1, 2, 4, 8, 16]

const F_STOPS = [
  1.4, 1.6, 1.8, 2, 2.2, 2.5, 2.8, 3.2, 3.5, 4, 4.5, 5, 5.6, 6.3, 7.1, 8, 9, 10, 11, 13, 14, 16, 18,
  20, 22
]
// シャッター速度は 1/x 秒の x で持つ
const SHUTTER_STOPS = [
  15, 20, 30, 40, 60, 80, 125, 160, 250, 320, 500, 640, 1000, 1250, 2000, 2500, 4000, 5000, 8000
]
const ISO_STOPS = [50, 64, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1600, 3200, 6400]
const FOCAL_MIN = 12
const FOCAL_MAX = 400

const query = new URLSearchParams(window.location.search)

const canvas = byId<HTMLCanvasElement>('view')

const renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.toneMapping = ACESFilmicToneMapping
renderer.toneMappingExposure = 1
renderer.shadowMap.enabled = true
renderer.shadowMap.type = PCFShadowMap

const scene = new Scene()
const rig = new CameraRig(canvas)
const lighting = new Lighting(scene)

const mowMap = new MowMap(renderer, {
  size: FIELD_SIZE,
  resolution: 2048,
  originX: FIELD_ORIGIN,
  originZ: FIELD_ORIGIN,
  maxHeight: MAX_GRASS_HEIGHT
})
mowMap.reset(UNCUT_HEIGHT)

const ground = createGround(mowMap, GROUND_EXTENT, UNCUT_HEIGHT)
scene.add(ground.mesh)

const params = FAIRWAY_MOWER
const mower = new MowerModel(params)
scene.add(mower.root)

const coverage = new CoverageGrid(FIELD_ORIGIN, FIELD_ORIGIN, FIELD_SIZE, FIELD_SIZE, 0.5)

// HDR(半精度浮動小数点)で描いてから、トーンマッピングして画面に出す
const composer = new EffectComposer(
  renderer,
  new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 })
)
composer.addPass(new RenderPass(scene, rig.camera))
composer.addPass(new OutputPass())

const sim = {
  state: createVehicleState(-21, -55, 0),
  timeScale: 1,
  cutHeightMm: 18,
  autoDrive: false,
  elapsed: 0,
  distance: 0
}
let driver = createDriver()
let prevDeck: DeckSegment | null = null
let accumulator = 0

function createDriver(): LineDriver {
  return new LineDriver(
    { startX: -21, spacing: 2.8, lines: 16, zMin: -40, zMax: 40, headland: 10 },
    params
  )
}

function resetAll(): void {
  sim.state = createVehicleState(-21, -55, 0)
  sim.elapsed = 0
  sim.distance = 0
  driver = createDriver()
  prevDeck = null
  accumulator = 0
  coverage.reset()
  mowMap.reset(UNCUT_HEIGHT)
}

// 起動時の指定(動作確認用): ?auto=1&timescale=16&cam=orbit&ui=0&help=1
if (query.get('auto') === '1') sim.autoDrive = true
const queryScale = Number(query.get('timescale'))
if (queryScale > 0) sim.timeScale = queryScale
const queryCam = query.get('cam') as CameraMode | null
if (queryCam && CAMERA_MODES.includes(queryCam)) rig.setMode(queryCam)
if (query.get('ui') === '0') document.body.classList.add('minimal-ui')
// ------------------------------------------------ UI

const syncs: Sync[] = []
function syncUi(): void {
  for (const sync of syncs) sync()
}

const setStatus = addReadout(byId('status-readout'), {
  speed: '速度',
  deck: '刈刃',
  area: '刈った面積',
  distance: '走行距離',
  elapsed: '経過時間'
})
const setCameraReadout = addReadout(byId('camera-readout'), {
  lens: 'レンズ',
  exposure: '露出'
})
const fpsCounter = byId('fps-counter')

const cameraFields = byId('camera-fields')
const focalRange = Math.log(FOCAL_MAX / FOCAL_MIN)
syncs.push(
  addSlider(cameraFields, {
    label: '焦点距離',
    title: 'レンズの焦点距離。大きいほど望遠になります。視点を切り替えると、その視点の初期値に戻ります',
    min: 0,
    max: 1,
    step: 0.005,
    get: () => Math.log(rig.settings.focalLength / FOCAL_MIN) / focalRange,
    set: (t) => {
      rig.settings.focalLength = Math.round(FOCAL_MIN * Math.exp(t * focalRange))
    },
    format: (t) => `${Math.round(FOCAL_MIN * Math.exp(t * focalRange))} mm`
  }),
  addSlider(
    cameraFields,
    stopsSlider(
      'F 値',
      F_STOPS,
      () => rig.settings.fNumber,
      (v) => {
        rig.settings.fNumber = v
      },
      (v) => `F${v}`,
      'レンズの絞り。小さいほど明るくなります(1 段で 2 倍)'
    )
  ),
  addSlider(
    cameraFields,
    stopsSlider(
      'シャッター',
      SHUTTER_STOPS,
      () => 1 / rig.settings.shutterTime,
      (v) => {
        rig.settings.shutterTime = 1 / v
      },
      (v) => `1/${v}`,
      'シャッター速度(秒)。遅いほど明るくなります'
    )
  ),
  addSlider(
    cameraFields,
    stopsSlider(
      'ISO',
      ISO_STOPS,
      () => rig.settings.iso,
      (v) => {
        rig.settings.iso = v
      },
      (v) => String(v),
      'ISO 感度。高いほど明るくなります'
    )
  ),
  addSlider(cameraFields, {
    label: '露出補正',
    title: '全体の明るさを段数でずらします',
    min: -3,
    max: 3,
    step: 1 / 3,
    get: () => rig.settings.exposureCompensation,
    set: (v) => {
      rig.settings.exposureCompensation = v
    },
    format: (v) => `${v > 0.01 ? '+' : ''}${v.toFixed(1)} EV`
  })
)

const lightFields = byId('light-fields')
syncs.push(
  addSlider(lightFields, {
    label: '太陽の高度',
    title: '低いほど影が長くなり、縞がはっきり見えます',
    min: 3,
    max: 85,
    step: 1,
    get: () => lighting.settings.sunElevation,
    set: (v) => {
      lighting.settings.sunElevation = v
    },
    format: (v) => `${v.toFixed(0)}°`
  }),
  addSlider(lightFields, {
    label: '太陽の方位',
    min: 0,
    max: 360,
    step: 1,
    get: () => lighting.settings.sunAzimuth,
    set: (v) => {
      lighting.settings.sunAzimuth = v
    },
    format: (v) => `${v.toFixed(0)}°`
  })
)

const grassFields = byId('grass-fields')
syncs.push(
  addSlider(grassFields, {
    label: '縞(視線)',
    title: '芝の倒れた向きと、見る向きの関係でつく明暗の強さ',
    min: 0,
    max: 1,
    step: 0.01,
    get: () => ground.uniforms.uStripe.value,
    set: (v) => {
      ground.uniforms.uStripe.value = v
    },
    format: (v) => v.toFixed(2)
  }),
  addSlider(grassFields, {
    label: '縞(太陽)',
    title: '芝の倒れた向きと、太陽の向きの関係でつく明暗の強さ',
    min: 0,
    max: 1,
    step: 0.01,
    get: () => ground.uniforms.uTilt.value,
    set: (v) => {
      ground.uniforms.uTilt.value = v
    },
    format: (v) => v.toFixed(2)
  }),
  addSlider(grassFields, {
    label: '刈高',
    title: 'これから刈る所の芝丈',
    min: 5,
    max: 60,
    step: 1,
    get: () => sim.cutHeightMm,
    set: (v) => {
      sim.cutHeightMm = v
    },
    format: (v) => `${v.toFixed(0)} mm`
  })
)

syncs.push(
  addSwitch(
    byId('speed-switch'),
    TIME_SCALES.map((scale, i) => ({
      value: scale,
      label: `${scale}×`,
      title: `${scale} 倍速(${i + 1})`
    })),
    () => sim.timeScale,
    (v) => {
      sim.timeScale = v
    }
  ),
  addSwitch(
    byId('view-switch'),
    CAMERA_MODES.map((mode) => ({
      value: mode,
      label: CAMERA_MODE_LABELS[mode],
      title: `${CAMERA_MODE_LABELS[mode]}の視点(C で切り替え)`
    })),
    () => rig.mode,
    (mode) => {
      rig.setMode(mode)
      syncUi()
    }
  )
)

const autoButton = byId<HTMLButtonElement>('toggle-auto')
function setAutoDrive(on: boolean): void {
  sim.autoDrive = on
  syncUi()
}
syncs.push(() => {
  autoButton.setAttribute('aria-pressed', String(sim.autoDrive))
  const label = sim.autoDrive ? '自動運転(仮)を止める' : '自動運転(仮)'
  autoButton.setAttribute('aria-label', label)
  autoButton.title = `${label}(P)`
})
autoButton.addEventListener('click', () => {
  setAutoDrive(!sim.autoDrive)
  autoButton.blur()
})
const resetButton = byId<HTMLButtonElement>('reset')
resetButton.addEventListener('click', () => {
  resetAll()
  resetButton.blur()
})

const toggleHelp = setupHelp([
  {
    title: '運転',
    items: [
      { keys: ['W', '↑'], text: '前進' },
      { keys: ['S', '↓'], text: '後退' },
      { keys: ['A', '←'], text: '左へ操舵' },
      { keys: ['D', '→'], text: '右へ操舵' },
      { keys: ['Space'], text: '刈刃の上げ下げ' }
    ]
  },
  {
    title: '視点',
    items: [
      { keys: ['C'], text: '視点を切り替える(追従、ドローン、俯瞰)' },
      { keys: ['左ドラッグ'], text: 'ドローン視点で回り込む' },
      { keys: ['ホイール'], text: 'ドローン視点で近づく、離れる' }
    ]
  },
  {
    title: 'シミュレーション',
    items: [
      { keys: ['1', '〜', '5'], text: '倍速(1、2、4、8、16 倍)' },
      { keys: ['P'], text: '自動運転(仮)の開始と停止' },
      { keys: ['R'], text: 'やり直し(芝を元に戻す)' }
    ]
  },
  {
    title: 'その他',
    items: [{ keys: ['?'], text: 'この一覧を開く、閉じる' }]
  }
])
if (query.get('help') === '1') toggleHelp()

const input = new KeyboardInput(window)
input.onPress('Space', () => {
  if (!sim.autoDrive) sim.state.deckDown = !sim.state.deckDown
})
input.onPress('KeyC', () => {
  rig.nextMode()
  syncUi()
})
input.onPress('KeyP', () => setAutoDrive(!sim.autoDrive))
input.onPress('KeyR', resetAll)
input.onPress('Slash', toggleHelp)
TIME_SCALES.forEach((scale, i) => {
  input.onPress(`Digit${i + 1}`, () => {
    sim.timeScale = scale
    syncUi()
  })
})
syncUi()

// ------------------------------------------------ シミュレーション

function stepSimulation(): void {
  const state = sim.state
  let vehicleInput = input.read()
  if (sim.autoDrive) {
    const out = driver.update(state)
    vehicleInput = out
    state.deckDown = out.deckDown
  }

  stepVehicle(state, vehicleInput, params, SIM_DT)
  sim.elapsed += SIM_DT
  sim.distance += Math.abs(state.speed) * SIM_DT

  const deck = deckSegment(state, params)
  if (state.deckDown && prevDeck && Math.abs(state.speed) > 0.01) {
    const sign = state.speed >= 0 ? 1 : -1
    mowMap.addQuad(
      prevDeck.lx,
      prevDeck.lz,
      prevDeck.rx,
      prevDeck.rz,
      deck.rx,
      deck.rz,
      deck.lx,
      deck.lz,
      Math.sin(state.heading) * sign,
      Math.cos(state.heading) * sign,
      sim.cutHeightMm / 1000
    )
    coverage.markSegment(deck.lx, deck.lz, deck.rx, deck.rz)
  }
  prevDeck = state.deckDown ? deck : null
}

function resize(): void {
  const w = window.innerWidth
  const h = window.innerHeight
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(w, h, false)
  composer.setPixelRatio(renderer.getPixelRatio())
  composer.setSize(w, h)
  rig.setAspect(w / h)
}
window.addEventListener('resize', resize)
resize()

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

let fps = 60
function updateReadouts(dt: number): void {
  if (dt > 0) fps += (1 / dt - fps) * 0.05
  const s = rig.settings
  setStatus({
    speed: `${(sim.state.speed * 3.6).toFixed(1)} km/h`,
    deck: sim.state.deckDown ? '下げ' : '上げ',
    area: `${coverage.coveredArea.toFixed(0)} m²`,
    distance: `${sim.distance.toFixed(0)} m`,
    elapsed: formatTime(sim.elapsed)
  })
  setCameraReadout({
    lens: `${s.focalLength.toFixed(0)} mm  F${s.fNumber}`,
    exposure: `1/${Math.round(1 / s.shutterTime)} 秒  ISO ${s.iso}  EV ${ev100(s.fNumber, s.shutterTime, s.iso).toFixed(1)}`
  })
  const fpsText = `${fps.toFixed(0)} fps`
  if (fpsCounter.textContent !== fpsText) fpsCounter.textContent = fpsText
}

let last = performance.now()
function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.1)
  last = now

  accumulator += dt * sim.timeScale
  let steps = 0
  while (accumulator >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
    stepSimulation()
    accumulator -= SIM_DT
    steps++
  }
  if (steps === MAX_STEPS_PER_FRAME) accumulator = 0
  mowMap.flush()

  mower.sync(sim.state, dt * sim.timeScale)
  rig.update(sim.state, dt)
  lighting.update(rig.exposure, rig.focusPoint, rig.camera.position)
  composer.render()
  updateReadouts(dt)
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
