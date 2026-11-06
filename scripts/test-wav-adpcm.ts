/**
 * IMA ADPCM WAV 解码单测（不启动 Electron）。
 *
 * 用 osu! 谱面目录里的真实音效：它们就是 Chromium decodeAudioData 解不了的那批，
 * 导入后「代码在、试听没声」正是这个原因。
 */
import { readFileSync, existsSync } from 'node:fs'
import { decodeImaAdpcmWav } from '../src/audio/wav'

let bad = 0
function ok(cond: boolean, name: string) {
  if (!cond) {
    bad++
    console.log(`FAIL ${name}`)
  } else console.log(`ok   ${name}`)
}

const DIR = 'E:/osu/Songs/Starlight Kuku Gumi - Watashi tachi wa mou Butai no ue (SparkNights)'
const ADPCM = ['soft-hitnormal8.wav', 'drum-hitnormal18.wav']
const PCM = ['normal-hitnormal8.wav', 'soft-hitclap18.wav']

for (const name of ADPCM) {
  const p = `${DIR}/${name}`
  if (!existsSync(p)) {
    console.log(`skip ${name}（文件不存在）`)
    continue
  }
  const raw = readFileSync(p)
  const got = decodeImaAdpcmWav(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer)
  ok(!!got, `${name} 解出来了`)
  if (!got) continue
  const dur = got.frames / got.sampleRate
  ok(got.channels === 2 && got.sampleRate === 44100, `${name} 声道/采样率：${got.channels}/${got.sampleRate}`)
  ok(got.frames > 0 && dur > 0.02 && dur < 2, `${name} 时长 ${(dur * 1000).toFixed(0)}ms`)
  let peak = 0
  let nonzero = 0
  for (const ch of got.data) {
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i])
      if (v > peak) peak = v
      if (v > 0.001) nonzero++
    }
  }
  ok(peak > 0.01, `${name} 有实际波形，峰值 ${peak.toFixed(3)}`)
  ok(nonzero > got.frames, `${name} 非静音样本 ${nonzero}`)
  ok(got.data.every((ch) => ch.length === got.frames), `${name} 每声道长度一致`)
}

for (const name of PCM) {
  const p = `${DIR}/${name}`
  if (!existsSync(p)) continue
  const raw = readFileSync(p)
  const got = decodeImaAdpcmWav(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer)
  ok(got === null, `${name} 是普通 PCM，不归这里管（返回 null）`)
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
process.exitCode = bad ? 1 : 0
