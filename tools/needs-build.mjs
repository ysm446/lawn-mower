// ビルドが必要かを調べる(start.bat から呼ぶ)。終了コードが 0 なら最新、1 ならビルドが要る。
// ビルドの出力がないか、出力の中で最も古いものより新しいソースがあれば要るとする。
// git pull や checkout で書き換わったファイルも更新日時が新しくなるので、取り込んだ変更も拾える。
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputs = ['out/main/index.js', 'out/renderer/index.html']
const inputs = ['src', 'package.json', 'package-lock.json', 'electron.vite.config.ts', 'tsconfig.json']

function newestTime(target) {
  const stat = statSync(target)
  if (!stat.isDirectory()) return stat.mtimeMs
  let newest = 0
  for (const entry of readdirSync(target)) newest = Math.max(newest, newestTime(path.join(target, entry)))
  return newest
}

function oldestOutput() {
  let oldest = Infinity
  for (const file of outputs) {
    try {
      oldest = Math.min(oldest, statSync(path.join(root, file)).mtimeMs)
    } catch {
      return { missing: file }
    }
  }
  return { time: oldest }
}

const output = oldestOutput()
if (output.missing) {
  console.log(`[start] ${output.missing} not found.`)
  process.exit(1)
}
for (const input of inputs) {
  let time
  try {
    time = newestTime(path.join(root, input))
  } catch {
    continue // ないファイルは比べない
  }
  if (time > output.time) {
    console.log(`[start] ${input} is newer than the build output.`)
    process.exit(1)
  }
}
process.exit(0)
