/**
 * MIDI / musictxt → [Keysound] 导入（单元测试）。
 *
 * 覆盖：
 *  - SMF 解析：format 0/1、running status、速度表、note on vel=0、轨道名/通道/program；
 *  - 量化：1/4 ~ 1/64、同一格和弦、最大误差；
 *  - 写回：已有小节、谱面末尾补 `#毫秒`、没有 [Keysound] 段时建段、多谱表 `|`；
 *  - 参数：移调、音域外拉回/跳过、力度→音量、清空目标谱表；
 *  - musictxt 来源：按谱表取音符、搬定义、补谱表头。
 */
import { parseChart } from '../src/core/parse'
import { parseMidi, describeMidi } from '../src/core/midi'
import {
  ensureKeysoundStaff,
  importKeysoundNotes,
  readChartKeysound,
  transcribedDefine,
  upsertKeysoundDefine,
} from '../src/core/importKeysound'

let pass = 0
let fail = 0
function T(name: string, ok: boolean, extra = '') {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
}

// ---------------------------------------------------------------------------
// 造 MIDI 字节
// ---------------------------------------------------------------------------

function vlq(n: number): number[] {
  const out = [n & 0x7f]
  n >>= 7
  while (n > 0) {
    out.unshift((n & 0x7f) | 0x80)
    n >>= 7
  }
  return out
}

interface Ev {
  /** 相对上一个事件的 tick 数 */
  delta: number
  bytes: number[]
}

function track(events: Ev[], name?: string): number[] {
  const body: number[] = []
  if (name) {
    const text = [...name].map((c) => c.charCodeAt(0))
    body.push(0, 0xff, 0x03, ...vlq(text.length), ...text)
  }
  for (const e of events) body.push(...vlq(e.delta), ...e.bytes)
  body.push(0, 0xff, 0x2f, 0)
  return [
    0x4d, 0x54, 0x72, 0x6b,
    (body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff, (body.length >>> 8) & 0xff, body.length & 0xff,
    ...body,
  ]
}

function midiFile(ppq: number, tracks: number[][], format = 1): ArrayBuffer {
  const head = [
    0x4d, 0x54, 0x68, 0x64,
    0, 0, 0, 6,
    (format >> 8) & 0xff, format & 0xff,
    (tracks.length >> 8) & 0xff, tracks.length & 0xff,
    (ppq >> 8) & 0xff, ppq & 0xff,
  ]
  return new Uint8Array([...head, ...tracks.flat()]).buffer
}

const on = (pitch: number, vel = 100, ch = 0): number[] => [0x90 | ch, pitch, vel]
const off = (pitch: number, ch = 0): number[] => [0x80 | ch, pitch, 0]
const tempo = (bpm: number): number[] => {
  const us = Math.round(60000000 / bpm)
  return [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]
}

// ---------------------------------------------------------------------------
// 1) SMF 解析
// ---------------------------------------------------------------------------
{
  // 480 tick/四分，120 BPM：1 tick = 500/480 ms
  const m = parseMidi(
    midiFile(480, [
      track(
        [
          { delta: 0, bytes: on(60, 100) },
          { delta: 480, bytes: off(60) },
          { delta: 0, bytes: on(62, 80) },
          { delta: 480, bytes: off(62) },
        ],
        'Melody',
      ),
    ], 0),
  )
  T('format 0 解析', m.format === 0 && m.ppq === 480, JSON.stringify({ f: m.format, ppq: m.ppq }))
  T('轨道名读出来', m.tracks[0]?.name === 'Melody', m.tracks[0]?.name)
  T('两个音符', m.tracks[0]?.notes.length === 2, String(m.tracks[0]?.notes.length))
  T('第一个音 0~500ms', m.tracks[0].notes[0].start === 0 && Math.abs(m.tracks[0].notes[0].end - 500) < 0.01, JSON.stringify(m.tracks[0].notes[0]))
  T('第二个音 500~1000ms', Math.abs(m.tracks[0].notes[1].start - 500) < 0.01 && Math.abs(m.tracks[0].notes[1].end - 1000) < 0.01, JSON.stringify(m.tracks[0].notes[1]))
  T('力度保留', m.tracks[0].notes[0].velocity === 100 && m.tracks[0].notes[1].velocity === 80)
}

{
  // 速度表：0 tick 120BPM，960 tick 起 60BPM；1440 tick 的音应在 2000ms
  const m = parseMidi(
    midiFile(480, [
      track([
        { delta: 0, bytes: tempo(120) },
        { delta: 960, bytes: tempo(60) },
        { delta: 480, bytes: on(72) },
        { delta: 0, bytes: off(72) },
      ]),
    ], 0),
  )
  T('速度变化换算正确', Math.abs(m.tracks[0].notes[0].start - 2000) < 0.01, String(m.tracks[0].notes[0].start))
  T('速度表两条', m.tempo.length === 2 && Math.round(m.tempo[0].bpm) === 120 && Math.round(m.tempo[1].bpm) === 60, JSON.stringify(m.tempo))
}

{
  // running status：第二个 note on 省略状态字节；note on vel=0 当 note off
  const m = parseMidi(
    midiFile(480, [
      track([
        { delta: 0, bytes: [0x90, 60, 90] },
        { delta: 240, bytes: [60, 0] }, // running status: note on vel 0 = off
        { delta: 0, bytes: [62, 90] },
        { delta: 240, bytes: [62, 0] },
      ]),
    ], 0),
  )
  T('running status 能解析', m.tracks[0]?.notes.length === 2, String(m.tracks[0]?.notes.length))
  T('note on vel=0 收尾', Math.abs(m.tracks[0].notes[0].end - 250) < 0.01, String(m.tracks[0].notes[0].end))
}

{
  // 多轨 + 打击乐通道 + program change
  const m = parseMidi(
    midiFile(96, [
      track([{ delta: 0, bytes: tempo(150) }], 'Tempo'),
      track(
        [
          { delta: 0, bytes: [0xc0, 40] },
          { delta: 0, bytes: on(64, 90) },
          { delta: 96, bytes: off(64) },
        ],
        'Piano',
      ),
      track([{ delta: 0, bytes: on(36, 120, 9) }, { delta: 96, bytes: off(36, 9) }], 'Drums'),
    ]),
  )
  T('空轨被过滤，剩两条', m.tracks.length === 2, JSON.stringify(m.tracks.map((x) => x.name)))
  T('program change 记录', m.tracks[0].programs.join() === '40', JSON.stringify(m.tracks[0].programs))
  T('打击乐通道标记', m.tracks[1].percussion === true && m.tracks[1].channels[0] === 9, JSON.stringify(m.tracks[1]))
  T('描述文本带轨道数', describeMidi(m).includes('2 条'), describeMidi(m))
}

{
  // 没有 note off 的音符收在轨道结尾
  const m = parseMidi(midiFile(480, [track([{ delta: 0, bytes: on(60) }, { delta: 480, bytes: tempo(120) }])], 0))
  T('缺 note off 仍保留音符', m.tracks[0].notes.length === 1 && m.tracks[0].notes[0].end >= 500, JSON.stringify(m.tracks[0].notes[0]))
}

{
  let err = ''
  try {
    parseMidi(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]).buffer)
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }
  T('不是 MIDI 时给出错误', err.includes('MThd'), err)
}

// ---------------------------------------------------------------------------
// 2) 写回 chart
// ---------------------------------------------------------------------------

const BASE = `[Metadata]
Title = ks

[Files]
audio = ""

[Define]
keysound custom piano = ("piano/<loop("C","H","D","I","E","F","J","G","K","A","L","B")><int((i+9)/12)>.wav", A0, C8)

[Timing]
0,bpm(120),4,0,0

[Keysound]
{piano}
/4C = = =/

[Hitsound]
/Aa = = =/
`

const ksEvents = (text: string) =>
  parseChart(text)
    .events.filter((e) => e.kind === 'keysound')
    .map((e) => `${Math.round(e.time)}:${e.pitch}@${e.staff ?? 0}`)

{
  const doc = parseChart(BASE)
  const r = importKeysoundNotes(
    doc,
    [
      { pitch: 60, time: 0 },
      { pitch: 62, time: 250 },
      { pitch: 64, time: 500 },
      { pitch: 65, time: 750 },
    ],
    { staff: 0, div: 4, instrument: 'piano' },
  )
  T('基本导入成功', r.ok, r.reason)
  T('4 个音都写进去', ksEvents(r.text!).join(' ') === '0:60@0 250:62@0 500:64@0 750:65@0', ksEvents(r.text!).join(' '))
  T('统计：4 格 1 小节', r.stats.cells === 4 && r.stats.measures === 1, JSON.stringify(r.stats))
  T('没有量化误差', r.stats.quantizeMs === 0, String(r.stats.quantizeMs))
}

{
  // 同一格叠和弦 + 量化到最近的格
  const doc = parseChart(BASE)
  const r = importKeysoundNotes(
    doc,
    [
      { pitch: 60, time: 120 },
      { pitch: 64, time: 130 },
      { pitch: 67, time: 300 },
    ],
    { staff: 0, div: 4, instrument: 'piano' },
  )
  const text = r.text || ''
  T('和弦写成一个格子', /\[4C 4E\]/.test(text), text.split('[Keysound]')[1])
  T('量化误差 50ms', Math.abs(r.stats.quantizeMs - 50) < 1, String(r.stats.quantizeMs))
  T('和弦只占 2 格', r.stats.cells === 2, String(r.stats.cells))
}

{
  // 谱面末尾：补 `#毫秒` + 新行
  const doc = parseChart(BASE)
  const r = importKeysoundNotes(doc, [{ pitch: 60, time: 4100 }, { pitch: 67, time: 4500 }], {
    staff: 0,
    div: 4,
    instrument: 'piano',
  })
  const text = r.text || ''
  T('补了 #4000 标记', /#4000\n/.test(text), text.split('[Hitsound]')[0].slice(-120))
  T('事件落在第 3 小节', ksEvents(text).includes('4125:60@0') && ksEvents(text).includes('4500:67@0'), ksEvents(text).join(' '))
  T('最后一小节 = 3', r.stats.maxMeasure === 3, String(r.stats.maxMeasure))
}

{
  // 移调 + 音域外
  const doc = parseChart(BASE)
  const clamp = importKeysoundNotes(doc, [{ pitch: 108, time: 0 }, { pitch: 20, time: 250 }], {
    staff: 0,
    div: 4,
    instrument: 'piano',
    transpose: 5,
    outOfRange: 'clamp',
  })
  T('超上限拉回音域', ksEvents(clamp.text!).includes('0:101@0'), ksEvents(clamp.text!).join(' '))
  T('下限 20 移调后仍在音域内', ksEvents(clamp.text!).includes('250:25@0'), ksEvents(clamp.text!).join(' '))

  const skip = importKeysoundNotes(doc, [{ pitch: 108, time: 0 }, { pitch: 60, time: 500 }], {
    staff: 0,
    div: 4,
    instrument: 'piano',
    transpose: 12,
    outOfRange: 'skip',
  })
  T(
    '越界音符被跳过',
    skip.stats.skipped === 1 && skip.stats.placed === 1 && !ksEvents(skip.text!).some((e) => e.endsWith(':84@0')),
    JSON.stringify({ stats: skip.stats, events: ksEvents(skip.text!) }),
  )
  const allSkip = importKeysoundNotes(doc, [{ pitch: 108, time: 0 }], {
    staff: 0,
    div: 4,
    instrument: 'piano',
    transpose: 12,
    outOfRange: 'skip',
  })
  T('全部越界时明确失败', !allSkip.ok && !!allSkip.reason, allSkip.reason)
}

{
  // 力度 → 音量
  const doc = parseChart(BASE)
  const r = importKeysoundNotes(doc, [{ pitch: 60, time: 250, velocity: 64 }], {
    staff: 0,
    div: 4,
    instrument: 'piano',
    volumeMode: 'velocity',
  })
  T('力度换成 <v=50>', /<v=50>/.test(r.text || ''), (r.text || '').split('[Keysound]')[1]?.split('[Hitsound]')[0])
}

{
  // 清空目标谱表
  const doc = parseChart(BASE)
  const r = importKeysoundNotes(doc, [{ pitch: 72, time: 250 }], {
    staff: 0,
    div: 4,
    instrument: 'piano',
    replace: true,
  })
  T('清空后只剩新音符', ksEvents(r.text!).join(' ') === '250:72@0', ksEvents(r.text!).join(' '))
  T('清空提示', r.warnings.some((w) => w.includes('清空')), r.warnings.join(' | '))
}

{
  // 没有 [Keysound] 段
  const plain = `[Metadata]
Title = t
[Files]
audio = ""
[Define]
keysound custom piano = ("piano/<loop("C")><int((i+9)/12)>.wav", A0, C8)
[Timing]
0,bpm(120),4,0,0
[Hitsound]
/Aa = = =/
`
  const r = importKeysoundNotes(parseChart(plain), [{ pitch: 60, time: 0 }], {
    staff: 0,
    div: 4,
    instrument: 'piano',
    instruments: ['piano'],
  })
  T('没有段时自动建段', r.ok && /\[Keysound\]\n\{piano\}/.test(r.text || ''), (r.text || '').slice(-120))
  T('新建段后能解析到音符', ksEvents(r.text!).join(' ') === '0:60@0', ksEvents(r.text!).join(' '))
}

{
  // 多谱表：写第 2 条谱表时要带 `|`
  const multi = BASE.replace('/4C = = =/', '/4C = = = | = = = =/')
  const doc = parseChart(multi)
  const r = importKeysoundNotes(doc, [{ pitch: 72, time: 500 }], {
    staff: 1,
    div: 4,
    instrument: 'piano',
  })
  T('第 2 谱表写入成功', r.ok && ksEvents(r.text!).includes('500:72@1'), r.reason || ksEvents(r.text!).join(' '))
  T('第 1 谱表没被动', ksEvents(r.text!).includes('0:60@0'), ksEvents(r.text!).join(' '))
}

{
  // 跨度写法（/2/ 后面跟区域）拒绝写回，而不是写坏
  const span = BASE.replace('/4C = = =/', '/1/ /4C = = =/')
  const r = importKeysoundNotes(parseChart(span), [{ pitch: 60, time: 2100 }], {
    staff: 0,
    div: 4,
    instrument: 'piano',
  })
  T('跨度小节拒绝改写', !r.ok && !!r.reason, r.reason)
}

{
  // 段末悬空的 /2/：补新行前要删掉，否则新内容会被摊到两小节上
  const dangling = BASE.replace('/4C = = =/', '/4C = = =/\n/2/')
  const r = importKeysoundNotes(parseChart(dangling), [{ pitch: 60, time: 2100 }], {
    staff: 0,
    div: 4,
    instrument: 'piano',
  })
  T('悬空跨度会被清掉', r.ok && !/\/2\/\s*$/.test((r.text || '').trim()), (r.text || '').split('[Hitsound]')[0].slice(-80))
  T('悬空跨度不影响新音符时间', ksEvents(r.text!).includes('2125:60@0'), ksEvents(r.text!).join(' '))
}

// ---------------------------------------------------------------------------
// 3) musictxt 来源 + 定义搬运
// ---------------------------------------------------------------------------
{
  const src = readChartKeysound(BASE)
  T('来源谱表信息', src.staves.length === 1 && src.staves[0].name === 'piano' && src.staves[0].count === 1, JSON.stringify(src.staves))
  T('来源音符带音高与谱表', src.notes[0]?.pitch === 60 && src.notes[0]?.staff === 0, JSON.stringify(src.notes[0]))
  T('来源定义抓到了 piano', src.defs.length === 1 && src.defs[0].name === 'piano', JSON.stringify(src.defs.map((d) => d.name)))
}

{
  const src = readChartKeysound(
    `[Metadata]
Title = s
[Files]
path = "E:/osu/maps/source"
audio = ""
[Define]
keysound custom violin = ("sub/<loop("C")><int((i+9)/12)>.wav", A0, C8)
[Timing]
0,bpm(120),4,0,0
[Keysound]
{violin}
/4C D/
`,
    'E:/osu/maps/source',
  )
  const moved = transcribedDefine(src.doc, src.defs[0], 'E:/osu/maps/source')
  T('相对路径补成来源绝对路径', moved.includes('"E:/osu/maps/source/sub/'), moved)
}

{
  const doc = parseChart(BASE)
  const defText = 'keysound custom guitar = "E:/osu/guitar.sf2" {bank=0,program=24}'
  const t1 = upsertKeysoundDefine(BASE, doc, defText, 'guitar')
  const d1 = parseChart(t1)
  T('新定义写进 [Define]', d1.hitsounds.some((h) => h.name === 'guitar' && h.library === 'sf2'), JSON.stringify(d1.hitsounds.map((h) => h.name)))
  const ens = ensureKeysoundStaff(t1, d1, 'guitar')
  const d2 = parseChart(ens.text)
  T('谱表头补上 guitar', ens.staff === 1 && d2.keyInstruments.map((k) => k.name).join('|') === 'piano|guitar', JSON.stringify(d2.keyInstruments))
  const t3 = upsertKeysoundDefine(BASE, doc, 'keysound custom piano = "E:/new/piano.sfz"', 'piano')
  T('同名定义整条替换', !t3.includes('loop(') && t3.includes('E:/new/piano.sfz'), t3.split('[Define]')[1])
}

{
  // 全新谱面：没有 [Define] / [Keysound]，从零建定义 → 建段 → 写音符
  const plain = `[Metadata]
Title = blank
[Files]
audio = ""
[Timing]
0,bpm(120),4,0,0
[Hitsound]
/= = = =/
`
  let t = upsertKeysoundDefine(plain, parseChart(plain), 'keysound custom lead = "E:/lead.sf2" {bank=0,program=81}', 'lead')
  let d = parseChart(t)
  T('没有 [Define] 时建出段', d.hitsounds.some((h) => h.name === 'lead' && h.library === 'sf2'), JSON.stringify(d.hitsounds.map((h) => h.name)))
  const ens = ensureKeysoundStaff(t, d, 'lead')
  t = ens.text
  d = parseChart(t)
  const r = importKeysoundNotes(d, [{ pitch: 60, time: 0 }, { pitch: 64, time: 500 }], {
    staff: ens.staff,
    div: 4,
    instrument: 'lead',
    instruments: ['lead'],
  })
  T('全新谱面能建 [Keysound] 段并写音符', r.ok && ksEvents(r.text!).join(' ') === '0:60@0 500:64@0', r.reason || ksEvents(r.text!).join(' '))
  T('新建的定义还在', parseChart(r.text!).hitsounds.some((h) => h.name === 'lead'))
}

console.log(`\n${fail ? `${fail} 项失败` : '全部通过'}（${pass} 项）`)
if (fail) process.exit(1)
