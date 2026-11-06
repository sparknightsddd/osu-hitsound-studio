/**
 * 混音工具单测（主进程用的 CommonJS 版本）。
 * 用真实音效：ADPCM + PCM 混合、单声道铺到立体声、输出能被重新读回。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { readWav, mixWavs, writeWav16, mixFilesTo } = require('../electron/wav-mix.cjs')

let bad = 0
function ok(cond, name) {
  if (!cond) {
    bad++
    console.log(`FAIL ${name}`)
  } else console.log(`ok   ${name}`)
}

const DIR = 'E:/osu/Songs/Starlight Kuku Gumi - Watashi tachi wa mou Butai no ue (SparkNights)'
const a = path.join(DIR, 'soft-hitnormal8.wav') // IMA ADPCM, 立体声
const b = path.join(DIR, 'soft-hitclap18.wav') // PCM 16, 立体声
const c = path.join(DIR, 'normal-hitnormal8.wav') // PCM 16, 单声道
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsmix-'))

const wa = readWav(a)
const wb = readWav(b)
const wc = readWav(c)
ok(!!wa && wa.channels === 2, `ADPCM 读出来了：${wa && wa.sampleRate}Hz ${wa && wa.channels}ch`)
ok(!!wb && wb.channels === 2, `PCM 音频读出来了：${wb && wb.sampleRate}Hz ${wb && wb.channels}ch`)
ok(!!wc && wc.channels === 1, `单声道 PCM 读出来了：${wc && wc.channels}ch`)

// 1) 两个立体声混音
{
  const out = path.join(tmp, 'mix1.wav')
  const r = mixFilesTo([a, b], out)
  ok(r.ok && fs.existsSync(out), `混音写盘成功：${r.errors.join('；')}`)
  const m = readWav(out)
  ok(!!m && m.channels === 2 && m.sampleRate === 44100, `输出 44100/2ch：${m && m.sampleRate}/${m && m.channels}`)
  const frames = m ? m.data[0].length : 0
  const expect = Math.max(wa.data[0].length, wb.data[0].length)
  ok(Math.abs(frames - expect) <= 2, `长度取较长的那段：${frames} vs ${expect}`)
  let peak = 0
  for (const ch of m.data) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]))
  ok(peak > 0.01, `混音结果不是静音，峰值 ${peak.toFixed(3)}`)
}

// 2) 单声道 + 立体声：两个声道都要有内容
{
  const mixed = mixWavs([wc, wb])
  ok(mixed.channels === 2, `升到立体声：${mixed.channels}`)
  let l = 0
  let r = 0
  for (let i = 0; i < 1000; i++) {
    l = Math.max(l, Math.abs(mixed.data[0][i]))
    r = Math.max(r, Math.abs(mixed.data[1][i]))
  }
  ok(l > 0 && r > 0, `左右声道都有声音：${l.toFixed(3)} / ${r.toFixed(3)}`)
}

// 3) 单份素材（等价于复制）
{
  const out = path.join(tmp, 'one.wav')
  const r = mixFilesTo([a], out)
  ok(r.ok && fs.existsSync(out), '单份也能写出')
  const m = readWav(out)
  ok(m && m.data[0].length === wa.data[0].length, '单份长度不变')
}

// 4) 坏文件：跳过并报告
{
  const badFile = path.join(tmp, 'bad.wav')
  fs.writeFileSync(badFile, 'not a wav')
  const out = path.join(tmp, 'partial.wav')
  const r = mixFilesTo([badFile, a], out)
  ok(r.ok && r.errors.length === 1, `坏文件被跳过：${r.errors[0]}`)
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
process.exitCode = bad ? 1 : 0
