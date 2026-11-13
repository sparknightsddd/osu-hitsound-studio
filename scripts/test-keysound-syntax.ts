/**
 * keysound 新语法 + SF2/SFZ 解析测试。
 *
 * 覆盖：
 *  - `keysound ... = "路径"` + 同行/下一行 `{...}` 参数块
 *  - multifile 的 files 列表 / 模板、singlefile 的 bank/preset/program/percussion
 *  - 旧元组语法仍然可用
 *  - 音域、文件数、模式等诊断
 *  - 最小 SF2 的 preset / zone / sample 解析
 *  - SFZ 的 global/group/region 继承
 */
import { parseChart } from '../src/core/parse'
import { keyZones, parseSoundFont, pickPreset, pcmToFloat, sampleBytes } from '../src/audio/soundfont'
import { parseSfz } from '../src/audio/sfz'

const B = String.fromCharCode(92)
let pass = 0
let fail = 0
function T(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`)
  }
}

function chart(defs: string): string {
  return [
    '[Metadata]',
    'Title = t',
    '[Files]',
    'path = "E:/osu"',
    'audio = ""',
    '[Define]',
    defs,
    '[Timing]',
    '0,bpm(120),4,0,0',
    '[Hitsound]',
    '/',
    '',
  ].join('\n')
}

function ks(defs: string) {
  const doc = parseChart(chart(defs))
  return {
    doc,
    def: doc.hitsounds.find((h) => h.kind === 'keysound')!,
    errors: doc.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message),
    warnings: doc.diagnostics.filter((d) => d.severity === 'warning').map((d) => d.message),
  }
}

const dir = `E:${B}osu${B}piano${B}`

// ---------------------------------------------------------------------------
// 1) 语法
// ---------------------------------------------------------------------------
{
  const r = ks(
    `keysound custom piano = "${dir}"\n{mode=multifile,lowest=21,highest=24,files={"A0.wav","A#0.wav","B0.wav","C1.wav"}}`,
  )
  T('列表模式没有报错', r.errors.length === 0, r.errors.join(' | '))
  T('mode = multifile', r.def.keys?.mode === 'multifile')
  T('音域 21~24', r.def.keys?.low === 21 && r.def.keys?.high === 24)
  T('列表 4 个文件', r.def.keys?.fileList?.length === 4)
  T('展开 4 个音高', r.def.keyFiles?.size === 4, String(r.def.keyFiles?.size))
  T(
    '路径拼到目录下',
    r.def.keyFiles?.get(21)?.replace(/\\/g, '/') === `E:/osu/piano/A0.wav`,
    r.def.keyFiles?.get(21),
  )
}

{
  const r = ks(
    `keysound custom piano = "${dir}"\n{lowest=A0,highest=A0,files="<loop("A","L")><int((i+9)/12)>.wav"}`,
  )
  T('模板模式没有报错', r.errors.length === 0, r.errors.join(' | '))
  T('模板展开到 A0.wav', r.def.keyFiles?.get(21)?.replace(/\\/g, '/') === 'E:/osu/piano/A0.wav', r.def.keyFiles?.get(21))
}

{
  const r = ks(
    `keysound custom piano = "E:${B}osu${B}piano.sf2"\n{mode=singlefile,bank=0,preset=0,program=8,percussion=true}`,
  )
  T('sf2 识别为 singlefile', r.def.keys?.mode === 'singlefile' && r.def.library === 'sf2')
  T('sf2 参数读出来了', r.def.keys?.program === 8 && r.def.keys?.percussion === true)
  T('sf2 没有逐音文件', !r.def.keyFiles)
}

{
  const r = ks(`keysound custom piano = "E:${B}osu${B}piano.sfz"`)
  T('sfz 自动识别为 singular', r.def.library === 'sfz' && r.def.keys?.mode === 'singlefile')
  T('sfz 默认 bank/program = 0', r.def.keys?.bank === 0 && r.def.keys?.program === 0)
}

{
  const r = ks(`keysound custom piano = "E:${B}osu${B}piano.sf2" {bank=128,program=8,percussion=true}`)
  T('同行花括号也能读', r.def.keys?.bank === 128 && r.def.keys?.percussion === true)
}

{
  const r = ks(`keysound custom piano = ("piano/<loop("A","A#")><int((i+9)/12)>.wav", A0, C8)`)
  T('旧元组语法仍可用', r.def.keys?.mode === 'multifile' && r.def.keyFiles?.size === 88, String(r.def.keyFiles?.size))
}

// 诊断
{
  const r = ks(`keysound custom piano = "${dir}"`)
  T('目录没有 files 报错', r.errors.some((e) => e.includes('files=')), r.errors.join(' | '))
}
{
  const r = ks(
    `keysound custom piano = "${dir}"\n{lowest=21,highest=30,files={"A0.wav","B0.wav"}}`,
  )
  T('文件数和音域不匹配报错', r.errors.some((e) => e.includes('需要')), r.errors.join(' | '))
}
{
  const r = ks(`keysound custom piano = "E:${B}osu${B}piano.sf2"\n{mode=multifile,lowest=21}`)
  T('音色库写成 multifile 会走模板警告', r.warnings.some((w) => w.includes('模板')), r.warnings.join(' | '))
}
{
  const r = ks(`keysound custom piano = "E:${B}osu${B}piano/" {bank=999}`)
  T('bank 超出范围报错', r.errors.some((e) => e.includes('bank')), r.errors.join(' | '))
}
{
  const r = ks(`keysound custom piano = "E:${B}osu${B}piano/" {lowest=H9}`)
  T('音高无法识别报错', r.errors.some((e) => e.includes('lowest')), r.errors.join(' | '))
}

// ---------------------------------------------------------------------------
// 2) SF2：一个 preset / 一个 instrument / 一个 sample
// ---------------------------------------------------------------------------
function enc(s: string) {
  return [...s].map((c) => c.charCodeAt(0))
}
function chunk(id: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + (data.length % 2))
  out.set(enc(id), 0)
  new DataView(out.buffer).setUint32(4, data.length, true)
  out.set(data, 8)
  return out
}
function list(type: string, chunks: Uint8Array[]): Uint8Array {
  const len = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(12 + len)
  out.set(enc('LIST'), 0)
  new DataView(out.buffer).setUint32(4, len + 4, true)
  out.set(enc(type), 8)
  let off = 12
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}
function makeSf2(): ArrayBuffer {
  const smpl = new Uint8Array(200)
  const sv = new DataView(smpl.buffer)
  for (let i = 0; i < 100; i++) sv.setInt16(i * 2, Math.round(Math.sin((i / 100) * Math.PI * 2) * 12000), true)

  const phdr = new Uint8Array(38 * 2)
  phdr.set(enc('Piano'), 0)
  new DataView(phdr.buffer).setUint16(20, 0, true)
  new DataView(phdr.buffer).setUint16(22, 0, true)
  phdr.set(enc('EOP'), 38)

  const pbag = new Uint8Array(8)
  new DataView(pbag.buffer).setUint16(0, 0, true)
  new DataView(pbag.buffer).setUint16(4, 1, true)

  const pgen = new Uint8Array(8)
  new DataView(pgen.buffer).setUint16(0, 41, true)
  new DataView(pgen.buffer).setUint16(2, 0, true)

  const inst = new Uint8Array(44)
  inst.set(enc('Piano'), 0)
  new DataView(inst.buffer).setUint16(20, 0, true)
  inst.set(enc('EOI'), 22)

  const ibag = new Uint8Array(8)
  new DataView(ibag.buffer).setUint16(0, 0, true)
  new DataView(ibag.buffer).setUint16(4, 1, true)

  const igen = new Uint8Array(8)
  new DataView(igen.buffer).setUint16(0, 53, true)
  new DataView(igen.buffer).setUint16(2, 0, true)

  const shdr = new Uint8Array(92)
  shdr.set(enc('C4'), 0)
  const hv = new DataView(shdr.buffer)
  hv.setUint32(20, 0, true)
  hv.setUint32(24, 100, true)
  hv.setUint32(28, 0, true)
  hv.setUint32(32, 100, true)
  hv.setUint32(36, 44100, true)
  hv.setUint8(40, 60)
  hv.setUint16(44, 1, true)
  shdr.set(enc('EOS'), 46)

  const parts = [
    list('sdta', [chunk('smpl', smpl)]),
    list('pdta', [
      chunk('phdr', phdr),
      chunk('pbag', pbag),
      chunk('pgen', pgen),
      chunk('inst', inst),
      chunk('ibag', ibag),
      chunk('igen', igen),
      chunk('shdr', shdr),
    ]),
  ]
  const len = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(12 + len)
  out.set(enc('RIFF'), 0)
  new DataView(out.buffer).setUint32(4, len + 4, true)
  out.set(enc('sfbk'), 8)
  let off = 12
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out.buffer
}

{
  const sf = parseSoundFont(makeSf2(), 'sf2')
  T('SF2 解析出 1 个 preset', sf.presets.length === 1 && sf.presets[0].name === 'Piano', JSON.stringify(sf.presets.map((p) => p.name)))
  T('preset 有 1 个 zone', sf.presets[0].zones.length === 1)
  T('zone 根音 60 / 音域 0~127', sf.presets[0].zones[0].rootKey === 60 && sf.presets[0].zones[0].keyHigh === 127)
  const pick = pickPreset(sf, { bank: 0, preset: 0, program: 0, percussion: false })
  T('按 bank/program 选中 Piano', pick.preset?.name === 'Piano' && !pick.warning)
  const zones = keyZones(pick.preset!)
  T('128 个音高都有 zone', zones.size === 128, String(zones.size))
  const bytes = sampleBytes(sf, sf.samples[0])!
  T('sample 字节数 200', bytes.length === 200, String(bytes.length))
  T('PCM 转浮点 100 帧', pcmToFloat(bytes).length === 100)
  const missing = pickPreset(sf, { bank: 5, preset: 0, program: 99, percussion: false })
  T('找不到 preset 时有 warning', !!missing.warning, missing.warning)
}

// ---------------------------------------------------------------------------
// 3) SFZ：global / group 继承 + 音名
// ---------------------------------------------------------------------------
{
  const sfz = parseSfz(`
// comment
<global> volume=-6
<group> lovel=1 hivel=127
<region> sample=Piano\\C4.wav key=C4
<region> sample=Piano\\A4.wav lokey=A4 hikey=C8 pitch_keycenter=A4 tune=+10
`)
  T('SFZ 解析出 2 个 region', sfz.regions.length === 2, String(sfz.regions.length))
  T('global volume 转成增益', Math.abs(sfz.regions[0].gain - Math.pow(10, -6 / 20)) < 1e-6, String(sfz.regions[0].gain))
  T('key=C4 同时是音域和根音', sfz.regions[0].keyLow === 60 && sfz.regions[0].keyHigh === 60 && sfz.regions[0].root === 60)
  T('区域音域 A4~C8', sfz.regions[1].keyLow === 69 && sfz.regions[1].keyHigh === 108)
  T('反斜杠 sample 转成 /', sfz.regions[0].sample === 'Piano/C4.wav', sfz.regions[0].sample)
}

// ---------------------------------------------------------------------------
// 4) 载入到引擎：SF2 / SFZ / 单一音频 → key layout
// ---------------------------------------------------------------------------
class FakeBuffer {
  numberOfChannels: number
  length: number
  sampleRate: number
  duration = 1
  private data: Float32Array[]
  constructor(ch: number, frames: number, rate: number) {
    this.numberOfChannels = ch
    this.length = frames
    this.sampleRate = rate
    this.data = Array.from({ length: ch }, () => new Float32Array(frames))
  }
  getChannelData(c: number) {
    return this.data[c] || this.data[0]
  }
}
class FakeCtx {
  currentTime = 0
  destination = {}
  sampleRate = 44100
  state = 'running'
  createBuffer(ch: number, frames: number, rate: number) {
    return new FakeBuffer(ch, frames, rate)
  }
  async decodeAudioData() {
    return new FakeBuffer(1, 441, 44100)
  }
  createGain() {
    return { gain: { value: 1 }, connect() {} }
  }
  createBufferSource() {
    return { buffer: null, playbackRate: { value: 1 }, connect() {}, start() {} }
  }
  resume() {}
}
;(globalThis as any).window = { AudioContext: FakeCtx }
;(globalThis as any).webkitAudioContext = FakeCtx

const { engine } = await import('../src/audio/engine')
const { loadKeysoundLibrary } = await import('../src/audio/keysoundLibrary')

function makeDef(text: string) {
  const doc = parseChart(chart(text))
  return doc.hitsounds.find((h) => h.kind === 'keysound')!
}
const sfReader = (buf: ArrayBuffer) => ({
  readMain: async () => buf,
  resolve: (r: string) => r,
  readPath: async () => null,
})

{
  const def = makeDef(`keysound custom piano = "E:/osu/piano.sf2"\n{bank=0,program=0}`)
  const r = await loadKeysoundLibrary('piano', def, sfReader(makeSf2()) as any)
  T('SF2 载入成功', r.ok && r.note.includes('Piano'), r.note)
  T('SF2 低/中/高音都有样本', engine.hasKeySample('piano', 21) && engine.hasKeySample('piano', 60) && engine.hasKeySample('piano', 108))
  T('SF2 buffer 名进引擎', engine.boundSampleNames().some((n) => n.startsWith('sf:piano:')))
}

{
  const sfz = [
    '<region> sample=C4.wav key=C4',
    '<region> sample=A4.wav lokey=A4 hikey=C8 pitch_keycenter=A4',
  ].join('\n')
  const def = makeDef(`keysound custom violin = "E:/osu/violin.sfz"`)
  const reader = {
    readMain: async () => new TextEncoder().encode(sfz).buffer,
    resolve: (r: string) => r,
    readPath: async () => new ArrayBuffer(16),
  }
  const r = await loadKeysoundLibrary('violin', def, reader as any)
  T('SFZ 载入成功', r.ok, r.note)
  T('SFZ 音域按 region 映射', engine.hasKeySample('violin', 60) && engine.hasKeySample('violin', 69) && engine.hasKeySample('violin', 108))
  T('SFZ 音域外没有样本', !engine.hasKeySample('violin', 61))
}

{
  const def = makeDef(`keysound custom flute = "E:/osu/flute.wav"`)
  const reader = {
    readMain: async () => new ArrayBuffer(16),
    resolve: (r: string) => r,
    readPath: async () => null,
  }
  const r = await loadKeysoundLibrary('flute', def, reader as any)
  T('单一音频载入成功', r.ok && r.note.includes('单一音频'), r.note)
  T('单一音频所有音高都有样本', engine.hasKeySample('flute', 0) && engine.hasKeySample('flute', 60) && engine.hasKeySample('flute', 127))
}

console.log(`\n${fail ? `${fail} 项失败` : '全部通过'}（${pass} 项）`)
process.exit(fail ? 1 : 0)
