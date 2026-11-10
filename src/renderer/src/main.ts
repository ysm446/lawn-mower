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
import GUI from 'lil-gui'
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

// 単位はすべて実寸(1 = 1 m)
const FIELD_SIZE = 256
const FIELD_ORIGIN = -FIELD_SIZE / 2
const GROUND_EXTENT = 5000
const MAX_GRASS_HEIGHT = 0.2
const UNCUT_HEIGHT = 0.07
const SIM_DT = 1 / 120
const MAX_STEPS_PER_FRAME = 600
const TIME_SCALES = [1, 2, 4, 8, 16]

const query = new URLSearchParams(window.location.search)

const canvas = document.getElementById('view') as HTMLCanvasElement
const hud = document.getElementById('hud') as HTMLDivElement

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

const input = new KeyboardInput(window)
input.onPress('Space', () => {
  if (!sim.autoDrive) sim.state.deckDown = !sim.state.deckDown
})
input.onPress('KeyC', () => {
  rig.nextMode()
  gui.controllersRecursive().forEach((c) => c.updateDisplay())
})
input.onPress('KeyP', () => {
  sim.autoDrive = !sim.autoDrive
  gui.controllersRecursive().forEach((c) => c.updateDisplay())
})
input.onPress('KeyR', resetAll)
TIME_SCALES.forEach((scale, i) => {
  input.onPress(`Digit${i + 1}`, () => {
    sim.timeScale = scale
    gui.controllersRecursive().forEach((c) => c.updateDisplay())
  })
})

// 調整用パネル
const gui = new GUI({ title: '設定' })
const cameraUi = { shutter: Math.round(1 / rig.settings.shutterTime), mode: rig.mode as CameraMode }
const cameraFolder = gui.addFolder('カメラ')
cameraFolder
  .add(cameraUi, 'mode', Object.fromEntries(CAMERA_MODES.map((m) => [CAMERA_MODE_LABELS[m], m])))
  .name('視点')
  .onChange((m: CameraMode) => {
    rig.setMode(m)
    gui.controllersRecursive().forEach((c) => c.updateDisplay())
  })
  .listen()
cameraFolder.add(rig.settings, 'focalLength', 12, 400, 1).name('焦点距離 (mm)').listen()
cameraFolder.add(rig.settings, 'fNumber', 1.4, 22, 0.1).name('絞り (F)')
cameraFolder
  .add(cameraUi, 'shutter', 15, 8000, 1)
  .name('シャッター (1/x 秒)')
  .onChange((v: number) => {
    rig.settings.shutterTime = 1 / v
  })
cameraFolder.add(rig.settings, 'iso', 50, 6400, 10).name('ISO')
cameraFolder.add(rig.settings, 'exposureCompensation', -3, 3, 0.1).name('露出補正 (EV)')

const lightFolder = gui.addFolder('光')
lightFolder.add(lighting.settings, 'sunElevation', 3, 85, 1).name('太陽の高度 (度)')
lightFolder.add(lighting.settings, 'sunAzimuth', 0, 360, 1).name('太陽の方位 (度)')

const grassFolder = gui.addFolder('芝')
grassFolder.add(ground.uniforms.uStripe, 'value', 0, 1, 0.01).name('縞の強さ(視線)')
grassFolder.add(ground.uniforms.uTilt, 'value', 0, 1, 0.01).name('縞の強さ(太陽)')
grassFolder.add(sim, 'cutHeightMm', 5, 60, 1).name('刈高 (mm)')

const simFolder = gui.addFolder('シミュレーション')
simFolder.add(sim, 'timeScale', TIME_SCALES).name('倍速').listen()
simFolder.add(sim, 'autoDrive').name('自動運転(仮)').listen()
simFolder.add({ reset: resetAll }, 'reset').name('やり直し')

// 起動時の指定(動作確認用): ?auto=1&timescale=16&cam=orbit
if (query.get('auto') === '1') sim.autoDrive = true
const queryScale = Number(query.get('timescale'))
if (queryScale > 0) sim.timeScale = queryScale
const queryCam = query.get('cam') as CameraMode | null
if (queryCam && CAMERA_MODES.includes(queryCam)) {
  rig.setMode(queryCam)
  cameraUi.mode = queryCam
}
if (query.get('ui') === '0') gui.hide()

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
function updateHud(dt: number): void {
  if (dt > 0) fps += (1 / dt - fps) * 0.05
  const s = rig.settings
  const ev = ev100(s.fNumber, s.shutterTime, s.iso)
  hud.textContent = [
    `速度      ${(sim.state.speed * 3.6).toFixed(1)} km/h`,
    `刈刃      ${sim.state.deckDown ? '下げ' : '上げ'}`,
    `刈った面積 ${coverage.coveredArea.toFixed(0)} m²`,
    `走行距離   ${sim.distance.toFixed(0)} m`,
    `経過時間   ${formatTime(sim.elapsed)}(${sim.timeScale} 倍速)`,
    `視点      ${CAMERA_MODE_LABELS[rig.mode]}  ${s.focalLength.toFixed(0)} mm  F${s.fNumber.toFixed(1)}  EV ${ev.toFixed(1)}`,
    `${fps.toFixed(0)} fps`
  ].join('\n')
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
  updateHud(dt)
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
