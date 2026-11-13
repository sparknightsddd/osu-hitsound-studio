/**
 * 延迟混音单测（successor 用）：A 在 0ms，B 延迟 250ms。
 * 不依赖外部音效文件，自己生成两段 1kHz 单声道 WAV。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { readWav, mixWavs, writeWav16 } = require('../electron/wav-mix.cjs')

let bad = 0
const ok = (cond, name, extra = '') => {
  if (!cond) {
    bad++
    console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`)
  } else console.log(`ok   ${name}${extra ? ' — ' + extra : ''}`)
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsdelay-'))
const rate = 1000
const mk = (name, samples) => {
  const data = [new Float32Array(samples)]
  const file = path.join(dir, name)
  writeWav16(file, { sampleRate: rate, channels: 1, data, frames: samples })
  return readWav(file)
}
const a = mk('a.wav', 100)
const b = mk('b.wav', 50)
a.data[0].fill(0.5)
b.data[0].fill(0.25)

const m = mixWavs([a, b], [0, 250])
ok(m.frames >= 300, '长度覆盖 B 的尾巴', String(m.frames))
ok(Math.abs(m.data[0][10] - 0.5) < 0.01, 'A 从 0ms 开始', String(m.data[0][10]))
ok(Math.abs(m.data[0][150]) < 0.01, '250ms 之前没有 B', String(m.data[0][150]))
ok(Math.abs(m.data[0][260] - 0.25) < 0.01, 'B 在 250ms 后出现', String(m.data[0][260]))
ok(Math.abs(m.data[0][99] - 0.5) < 0.01, 'A 在自己的长度内不受影响', String(m.data[0][99]))

fs.rmSync(dir, { recursive: true, force: true })
console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
process.exitCode = bad ? 1 : 0
