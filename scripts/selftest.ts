import { migrateSongToFiles, parseChart } from '../src/core/parse'
import { DEMO, TEMPLATE } from '../src/samples/demo'
import { fromOsu, toOsu, toTimelineCsv } from '../src/core/exporter'
import { entriesFromFiles, matchHitsounds, matchSong } from '../src/core/fileMatch'
import { beatAt, measureBeatTimes, measureTicks } from '../src/core/measures'
import { expandKeysoundPath, unquote } from '../src/core/keysound'
import {
  freqOf,
  isBlackKey,
  letterToSemi,
  midiOf,
  midiToName,
  nameToMidi,
} from '../src/core/pitch'

const doc = parseChart(DEMO)

console.log('=== 诊断 ===')
doc.diagnostics.forEach((d) => console.log(`[${d.severity}] ${d.code || ''} ${d.message}`))

console.log('\n=== 设置 ===')
console.log(JSON.stringify(doc.settings, null, 1))

console.log('\n=== 定义 ===')
doc.hitsounds.forEach((h) => console.log(`${h.name}\t${h.alts.map((a) => a.raw).join('|')}\t${JSON.stringify(h.indices)}\t${h.value}`))

console.log('\n=== 前 24 个音符 ===')
doc.events.slice(0, 24).forEach((e) => {
  console.log(
    `t=${e.time.toFixed(1)}ms 小节${e.measure} 拍${e.beat.toFixed(2)} ${e.kind === 'keysound' ? `[KS ${e.instrument}] ${e.names.join('+')} midi=${e.pitch}` : `${e.names.join('+')} idx=${e.index}`} v=${e.volume}`,
  )
})

console.log('\n=== 小节（前 12） ===')
doc.measures.slice(0, 12).forEach((m) =>
  console.log(`#${m.index + 1} ${m.start.toFixed(1)} -> ${m.end.toFixed(1)} (${(m.end - m.start).toFixed(1)}ms) ${m.meter}/4 bl=${m.beatLength.toFixed(3)}`),
)

console.log(`\n总计: ${doc.events.length} 音符 / ${doc.measures.length} 小节 / ${doc.diagnostics.length} 诊断`)

console.log('\n=== .osu 导出（前 40 行） ===')
console.log(toOsu(doc).split('\r\n').slice(0, 40).join('\n'))

console.log('\n=== CSV 前 5 行 ===')
console.log(toTimelineCsv(doc).split('\r\n').slice(0, 6).join('\n'))

// ---------- 单元校验 ----------
const T = (name: string, cond: boolean, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
console.log('\n=== 断言 ===')
const bl = 60000 / 174
T('小节长度 = 4 拍', Math.abs(doc.measures[0].end - doc.measures[0].start - 4 * bl) < 0.01)
const firstTwo = doc.events.filter((e) => e.kind !== 'keysound').slice(0, 2)
T('前两拍间隔 = 1/8 小节', Math.abs(firstTwo[1].time - firstTwo[0].time - (4 * bl) / 8) < 0.01, `${(firstTwo[1].time - firstTwo[0].time).toFixed(2)}`)
const v70 = doc.events.filter((e) => e.volume === 70)
T('音量指令生效', v70.length > 0, `${v70.length} 个`)
const idx5 = doc.events.filter((e) => e.index === 5)
T('音效组编号生效', idx5.length > 0, `${idx5.length} 个`)
T('乐句展开', doc.events.filter((e) => e.names[0] === 'K').length > 20)

// 跨小节延音
const d2 = parseChart(`[Timing]\n0,bpm(120),4,0,0\n[Hitsound]\n/JJJ-/-JJ-/\n`)
T('跨小节延音：第 3 个 J 时值延伸到下一小节', d2.events.length === 5 && Math.abs(d2.events[2].duration - 1500) < 1, JSON.stringify(d2.events.map((e) => [Math.round(e.time), Math.round(e.duration)])))

// 重复记号
const d3 = parseChart(`[Timing]\n0,bpm(120),4,0,0\n[Hitsound]\n/D K/\n/*3/\n`)
T('小节重复 *3 => 8 个音符', d3.events.length === 8, String(d3.events.length))

// 嵌套括号
const d4 = parseChart(`[Timing]\n0,bpm(120),4,0,0\n[Hitsound]\n/(A(BC))D/\n`)
T('嵌套括号 (A(BC))D', d4.events.length === 4 && Math.abs(d4.events[1].time - 500) < 0.01 && Math.abs(d4.events[2].time - 750) < 0.01 && Math.abs(d4.events[3].time - 1000) < 0.01, JSON.stringify(d4.events.map((e) => Math.round(e.time))))

// 代码小节
const d5 = parseChart(`[Timing]\n0,bpm(120),4,0,0\n[Hitsound]\n//K*16/\n`)
T('代码小节 2 小节等分 16 份', d5.events.length === 16 && Math.abs(d5.events[15].time - 3750) < 0.01, JSON.stringify([d5.events[0].time, d5.events[15].time]))

// 数字时值
const d6 = parseChart(`[Timing]\n0,bpm(120),4,0,0\n[Hitsound]\n/C3C/\n`)
T('C3C = 附点二分 + 四分', d6.events.length === 2 && Math.abs(d6.events[1].time - 1500) < 0.01, JSON.stringify(d6.events.map((e) => [Math.round(e.time), Math.round(e.duration)])))

// ---------- [Files] ----------
console.log('\n=== [Files] ===')
const d7 = parseChart(
  `[Files]\npath = "E:\\osu\\Songs\\foobar"\naudio = "audio.mp3"\n[Define]\nhitsound custom K = "hs/Kick.wav"\nhitsound custom X = "D:\\Music\\X.wav"\nhitsound custom D = default.normal-hitnormal\n`,
)
console.log('audioPath =', d7.audioPath)
console.log(d7.hitsounds.map((h) => [h.name, h.value, h.resolvedPath]))
T('audio 按 path 解析', d7.audioPath === 'E:\\osu\\Songs\\foobar\\audio.mp3', d7.audioPath)
T('相对路径音效解析', d7.hitsounds[0].resolvedPath === 'E:\\osu\\Songs\\foobar\\hs\\Kick.wav')
T('绝对路径保持原样', d7.hitsounds[1].resolvedPath === 'D:\\Music\\X.wav')
T('default.xxx 无解析路径', d7.hitsounds[2].resolvedPath === undefined)
const d8 = parseChart(`[Settings]\nSong = "E:/osu/songs/foo/bar.mp3"\n`)
T('旧版 Song 迁移到 [Files]', d8.settings.Audio === 'E:/osu/songs/foo/bar.mp3' && d8.settings.Path === 'E:\\osu\\songs\\foo' && d8.audioPath === 'E:\\osu\\songs\\foo\\bar.mp3', JSON.stringify([d8.settings.Path, d8.settings.Audio, d8.audioPath]))
T('Song 给出迁移提示', d8.diagnostics.some((d) => d.code === 'set-song-deprecated'))

// ---------- 旧格式迁移 ----------
const mig = migrateSongToFiles(`[Metadata]\nTitle = X\n\n[Settings]\nMode = default\nSong = "E:/osu/songs/foo/bar.mp3"\n`)
console.log('\n=== 迁移结果 ===\n' + mig)
T('迁移：插入 [Files]', /\[Files\]\npath = "E:\\osu\\songs\\foo"\naudio = "bar\.mp3"/.test(mig))
T('迁移：移除旧 Song 行', !/Song\s*=/.test(mig))
T('迁移：已有 [Files] 时不动', migrateSongToFiles('[Files]\npath = "a"\n') === '[Files]\npath = "a"\n')

// ---------- .osu 导入 ----------
console.log('\n=== .osu 导入 ===')
const OSU = [
  'osu file format v14',
  '',
  '[General]',
  'AudioFilename: audio.mp3',
  'Mode: 3',
  '',
  '[Metadata]',
  'Title:Foo',
  'TitleUnicode:フー',
  'Artist:Bar',
  'ArtistUnicode:バー',
  'Creator:me',
  'Version:Insane',
  'Source:',
  'Tags:a b',
  'BeatmapID:123',
  'BeatmapSetID:456',
  '',
  '[Difficulty]',
  'CircleSize:4',
  '',
  '[Events]',
  '',
  '[TimingPoints]',
  '500,300,4,2,0,60,1,0',
  '2500,300,4,2,0,60,1,0',
  '6000,300,4,2,0,60,1,0',
  '9000,300,3,2,0,60,1,0',
  '12000,-100,4,2,0,60,0,0',
  '',
  '[HitObjects]',
  '',
].join('\r\n')
const imp = fromOsu(OSU, TEMPLATE)
console.log(imp.text)
console.log('红线', imp.timingCount, '绿线', imp.skippedGreen)
const lines = imp.text.split('\n')
T('导入无连续空行', !/\n[ \t]*\n[ \t]*\n/.test(imp.text) && imp.text.split('\n\n\n').length === 1)
T('[Metadata] 每项一行', lines.filter((l) => /^(Title|Artist|Creator) =/.test(l)).length >= 3)
T('红线 4 条 / 绿线忽略 1 条', imp.timingCount === 4 && imp.skippedGreen === 1)
// 500 / 2500 / 6000 / 9000：后一段 3500 与 3000 都没超过 4000 阈值 => 都继承
T('后段 3500ms(<4000) => 继承（2.666667）', imp.text.includes('2500,300,4,0,2.666667'))
T('后段 3000ms(<4000) => 继承（3.666667）', imp.text.includes('6000,300,4,0,3.666667'))
T('拍号变化 => 不继承拍子', imp.text.includes('9000,300,3,1,0'))

// 后段 5000ms > 4000 => 2500 开新小节
const OSU_LONG = [
  'osu file format v14',
  '',
  '[General]',
  'AudioFilename: audio.mp3',
  'Mode: 0',
  '',
  '[Metadata]',
  'Title:Long',
  '',
  '[TimingPoints]',
  '500,300,4,2,0,60,1,0',
  '2500,300,4,2,0,60,1,0',
  '7500,300,4,2,0,60,1,0',
  '',
  '[HitObjects]',
  '',
].join('\r\n')
const impLong = fromOsu(OSU_LONG, TEMPLATE)
T('后段 5000ms(>4000) => 新小节', impLong.text.includes('2500,300,4,1,0'))

// 弱起：2500 后面只有 400ms（很短），前后都短 => 继承，落在第 2.667 拍
const OSU_SHORT = [
  'osu file format v14',
  '',
  '[General]',
  'AudioFilename: audio.mp3',
  'Mode: 0',
  '',
  '[Metadata]',
  'Title:Pickup',
  '',
  '[TimingPoints]',
  '500,300,4,2,0,60,1,0',
  '2500,300,4,2,0,60,1,0',
  '2900,300,4,2,0,60,1,0',
  '',
  '[HitObjects]',
  '',
].join('\r\n')
const imp2 = fromOsu(OSU_SHORT, TEMPLATE)
T(
  '前后都短 => 继承（resetBeats=2.666667）',
  imp2.text.includes('2500,300,4,0,2.666667'),
)
T('Mode 映射', /Mode = mania/.test(imp.text))
T('audio 写入 [Files]', /audio = "audio\.mp3"/.test(imp.text))
T('导入结果可再解析且无错误', (() => {
  const dd = parseChart(imp.text)
  const errs = dd.diagnostics.filter((x) => x.severity === 'error')
  if (errs.length) console.log(errs.map((e) => e.message))
  return errs.length === 0 && dd.timing.length === 4
})())


// ============ 按 [Files] 自动匹配 ============
console.log('\n=== 文件自动匹配 ===')

function mkFile(path: string): File {
  const name = path.split(/[\\/]/).pop() || path
  const f = new File([new Uint8Array([1, 2, 3])], name, { type: 'audio/wav' }) as File
  Object.defineProperty(f, 'webkitRelativePath', { value: path })
  return f
}

const pickedA = [
  mkFile('foobar/audio.mp3'),
  mkFile('foobar/hs/Kick.wav'),
  mkFile('foobar/hs/Snare.wav'),
  mkFile('foobar/other/Noise.wav'),
]
const pickedB = [mkFile('Songs/foobar/audio.mp3'), mkFile('Songs/foobar/hs/Kick.wav')]
const pickedC = [mkFile('audio.mp3'), mkFile('Kick.wav'), mkFile('Snare.wav')]

const chart = parseChart(
  '[Files]\npath = "E:' +
    String.fromCharCode(92) +
    'osu' +
    String.fromCharCode(92) +
    'Songs' +
    String.fromCharCode(92) +
    'foobar"\naudio = "audio.mp3"\n\n[Define]\nhitsound custom K = "hs/Kick.wav"\nhitsound custom S = "hs/Snare.wav"\nhitsound custom X = "D:' +
    String.fromCharCode(92) +
    'Music' +
    String.fromCharCode(92) +
    'X.wav"\nhitsound custom D = default.normal-hitnormal\n\n[Timing]\n0,bpm(120),4,0,0\n[Hitsound]\n/K/\n',
)

{
  const es = entriesFromFiles(pickedA)
  const song = matchSong(chart, es)!
  T('选 foobar：歌曲精确命中 audio.mp3', song.file?.name === 'audio.mp3' && song.how === 'exact', song.file?.name + '/' + song.how)
  const ms = matchHitsounds(chart, es)
  T('选 foobar：K/S 精确命中', ms.length === 3 && ms[0].file?.name === 'Kick.wav' && ms[1].file?.name === 'Snare.wav', JSON.stringify(ms.map((m) => [m.target.name, m.file?.name, m.how])))
  T('选 foobar：绝对路径 X 未选则落空', ms[2].file === null)
  T('default 音效不参与匹配', !ms.some((m) => m.target.defaultRef))
}
{
  const es = entriesFromFiles(pickedB)
  const song = matchSong(chart, es)!
  T('选上层 Songs：歌曲按后缀命中', song.file?.name === 'audio.mp3' && song.how === 'suffix', song.file?.name + '/' + song.how)
  const ms = matchHitsounds(chart, es)
  T('选上层 Songs：K 命中 / S 落空', ms[0].file?.name === 'Kick.wav' && ms[1].file === null, JSON.stringify(ms.map((m) => [m.target.name, m.file?.name])))
}
{
  const es = entriesFromFiles(pickedC)
  const song = matchSong(chart, es)!
  T('散文件：歌曲命中 audio.mp3', song.file?.name === 'audio.mp3', song.file?.name + '/' + song.how)
  const ms = matchHitsounds(chart, es)
  T('散文件：K/S 按文件名命中', ms[0].file?.name === 'Kick.wav' && ms[1].file?.name === 'Snare.wav', JSON.stringify(ms.map((m) => [m.target.name, m.file?.name, m.how])))
}
T('目录里没有目标文件时不误命中', (() => {
  const es = entriesFromFiles([mkFile('nope/unrelated.ogg')])
  return matchSong(chart, es)!.file === null && matchHitsounds(chart, es).every((m) => m.file === null)
})())

// ============ 变 BPM：刻度必须随曲速变化 ============
console.log('\n=== 变 BPM ===')

// 4/4，120BPM(500ms/拍) -> 240BPM(250ms/拍)，变更落在 2000ms（正好是第 1 小节末尾）
const bpmChart = parseChart('[Timing]\n0,bpm(120),4,0,0\n2000,bpm(240),4,0,0\n\n[Define]\nhitsound custom K = default.normal-hitnormal\n\n[Hitsound]\n/K K K K/\n/K K K K/\n/K K K K/\n/K K K K/\n/K K K K/\n/K K K K/\n')
{
  const ms = bpmChart.measures
  const dump = JSON.stringify(ms.slice(0, 4).map((m) => [Math.round(m.start), Math.round(m.end), Math.round(m.beatLength)]))
  T('变BPM：小节0 = 0~2000（120BPM 4拍）', ms.length > 0 && Math.abs(ms[0].start) < 1 && Math.abs(ms[0].end - 2000) < 1, dump)
  T('变BPM：小节1 从 2000 起且 beatLength=250', ms.length > 1 && Math.abs(ms[1].start - 2000) < 1 && Math.abs(ms[1].beatLength - 250) < 0.01, ms[1] ? 'start=' + Math.round(ms[1].start) + ' bl=' + ms[1].beatLength.toFixed(1) : 'no m1')
  T('变BPM：小节1 长度 1000（240BPM 4拍）', ms.length > 1 && Math.abs(ms[1].end - ms[1].start - 1000) < 1, ms[1] ? 'len=' + Math.round(ms[1].end - ms[1].start) : '')

  const beats = ms.flatMap((m) => measureBeatTimes(m)).sort((a, b) => a - b)
  const early = beats.filter((t) => t >= 0 && t < 2000)
  const late = beats.filter((t) => t >= 2000 && t < 4000)
  const gapEarly = early.length > 1 ? early[1] - early[0] : -1
  const gapLate = late.length > 1 ? late[1] - late[0] : -1
  T('变BPM：慢段拍间隔 500ms', Math.abs(gapEarly - 500) < 1, 'gap=' + gapEarly)
  T('变BPM：快段拍间隔 250ms（刻度变密）', Math.abs(gapLate - 250) < 1, 'gap=' + gapLate)
  T('变BPM：不是恒定 BPM', Math.abs(gapEarly - gapLate) > 1, gapEarly + ' vs ' + gapLate)

  const ticks = ms.flatMap((m) => measureTicks(m, 4)).sort((a, b) => a - b)
  const tEarly = ticks.filter((t) => t >= 0 && t < 2000)
  const tLate = ticks.filter((t) => t >= 2000 && t < 3000)
  T('变BPM：1/4 刻度慢段间隔 125ms', tEarly.length > 1 && Math.abs(tEarly[1] - tEarly[0] - 125) < 1, String(tEarly.length > 1 ? tEarly[1] - tEarly[0] : -1))
  T('变BPM：1/4 刻度快段间隔 62.5ms', tLate.length > 1 && Math.abs(tLate[1] - tLate[0] - 62.5) < 1, String(tLate.length > 1 ? tLate[1] - tLate[0] : -1))
}

// 小节中途变速：120BPM 走 2 拍后变 240BPM（resetBeats=2）
const midChart = parseChart('[Timing]\n0,bpm(120),4,0,0\n1000,bpm(240),4,0,2\n\n[Define]\nhitsound custom K = default.normal-hitnormal\n\n[Hitsound]\n/K K K K/\n/K K K K/\n')
{
  const m0 = midChart.measures[0]
  T('小节内变速：长度 = 2*500 + 2*250 = 1500', !!m0 && Math.abs(m0.end - m0.start - 1500) < 1, m0 ? 'len=' + Math.round(m0.end - m0.start) : '')
  T('小节内变速：拆成 2 段', !!(m0 && m0.segments && m0.segments.length === 2), JSON.stringify(m0 && m0.segments ? m0.segments.map((s) => [Math.round(s.start), Math.round(s.end), Math.round(s.beatLength), s.beats]) : null))
  const beats = m0 ? measureBeatTimes(m0) : []
  T('小节内变速：拍点 0/500/1000/1250', beats.length === 4 && Math.abs(beats[1] - 500) < 1 && Math.abs(beats[3] - 1250) < 1, JSON.stringify(beats.map((b) => Math.round(b))))
  T('小节内变速：beatAt(1250) = 3', !!m0 && Math.abs(beatAt(m0, 1250) - 3) < 0.01, m0 ? String(beatAt(m0, 1250)) : '')
}

// 网格覆盖：正文只写 2 小节，但 [Timing] 在很后面才变速 —— 网格必须铺过去，
// 否则时间轴看不到这次变速（表现为「恒定 BPM」）
const lazyChart = parseChart('[Timing]\n0,bpm(120),4,0,0\n40000,bpm(240),4,0,0\n\n[Define]\nhitsound custom K = default.normal-hitnormal\n\n[Hitsound]\n/K K K K/\n/K K K K/\n')
{
  T('网格：正文只用 2 小节', lazyChart.usedMeasures === 2, 'used=' + lazyChart.usedMeasures)
  const ms = lazyChart.measures
  T('网格：铺到远超正文范围（>2 小节）', ms.length > 2, 'grid=' + ms.length)
  const reaches = ms.some((m) => m.start <= 40000 && m.end > 40000)
  T('网格：覆盖到 40s 的变速点', reaches, 'lastEnd=' + Math.round(ms[ms.length - 1].end))
  const after = ms.filter((m) => m.start >= 40000)
  T('网格：变速点之后仍有若干小节', after.length >= 8, 'after=' + after.length)
  T('网格：变速后 beatLength 变 250', after.length > 0 && Math.abs(after[0].beatLength - 250) < 0.01, after.length ? String(after[0].beatLength) : 'none')
}

// 空正文也要有网格可看
const emptyBody = parseChart('[Timing]\n0,bpm(120),4,0,0\n\n[Define]\nhitsound custom K = default.normal-hitnormal\n\n[Hitsound]\n')
{
  T('网格：空正文也有 >=32 小节', emptyBody.measures.length >= 32, 'grid=' + emptyBody.measures.length)
  T('网格：空正文 usedMeasures=0', emptyBody.usedMeasures === 0, 'used=' + emptyBody.usedMeasures)
}

// 变慢：120BPM -> 60BPM
const slowChart = parseChart('[Timing]\n0,bpm(120),4,0,0\n2000,bpm(60),4,0,0\n\n[Define]\nhitsound custom K = default.normal-hitnormal\n\n[Hitsound]\n/K K K K/\n/K K K K/\n/K K K K/\n/K K K K/\n')
{
  const ms = slowChart.measures
  const beats = ms.flatMap((m) => measureBeatTimes(m)).sort((a, b) => a - b)
  const late = beats.filter((t) => t >= 2000 && t < 6000)
  T('变BPM：变慢后拍间隔 1000ms（刻度变疏）', late.length > 1 && Math.abs(late[1] - late[0] - 1000) < 1, late.length > 1 ? String(late[1] - late[0]) : 'no beats')
}

// ============ /5/ = 把下一个区域摊在 5 个小节里 ============
console.log('\n=== 纯数字小节 /5/ ===')

const DEF = '[Define]\nhitsound custom K = default.normal-hitnormal\n\n'
const T120 = '[Timing]\n0,bpm(120),4,0,0\n\n'
const H = (body: string) => parseChart(T120 + DEF + '[Hitsound]\n' + body)

{
  // /5/K K K K/ 应等价于 /////K K K K/：K 摊在 5 个小节（0~10000ms）里
  const a = H('/5/K K K K/')
  const b = H('/////K K K K/')
  const spanOf = (c: ChartDoc) => {
    const ts = c.events.map((e) => e.time)
    return ts.length ? Math.max(...ts) - Math.min(...ts) : -1
  }
  T('/5/：4 个音符摊在 5 个小节内（总跨度 7500ms）', a.events.length === 4 && Math.abs(spanOf(a) - 7500) < 1, 'n=' + a.events.length + ' span=' + spanOf(a))
  T('/5/ 与 ///// 等价', a.events.length === b.events.length && Math.abs(spanOf(a) - spanOf(b)) < 1, 'a=' + spanOf(a) + ' b=' + spanOf(b))
  T('/5/：usedMeasures = 5', a.usedMeasures === 5, 'used=' + a.usedMeasures)
  T('/5/：数字不被当音符（没有名为 5 的事件）', !a.events.some((e) => e.names.includes('5')), JSON.stringify(a.events.map((e) => e.names)))
  T('/5/：K 起始时间 = 0（第 1 个小节开头）', a.events.length > 0 && Math.abs(a.events[0].time) < 1, a.events.length ? String(a.events[0].time) : '')

  // 常规空小节仍然是 /=/，不受影响
  const c = H('/=/K K K K/')
  T('/=/ 仍是空小节（音符从第 2 小节开始）', c.events.length === 4 && Math.abs(c.events[0].time - 2000) < 1, c.events.length ? String(c.events[0].time) : '')

  // 数字写在有音符的小节开头 = 音效组编号
  const d = H('/5K K K K/')
  T('/5K.../ 里的 5 是音效组编号', d.events.length === 4 && d.events.every((e) => e.index === 5), JSON.stringify(d.events.map((e) => e.index)))

  // /2/ 跨 2 小节
  const e = H('/2/K K/')
  // 2 个小节 = 4000ms，2 个音符各占 2000ms：0 -> 2000，跨度 2000
  T('/2/：2 个音符摊在 2 个小节（首音 0、次音 2000）', e.events.length === 2 && Math.abs(e.events[0].time) < 1 && Math.abs(e.events[1].time - 2000) < 1, JSON.stringify(e.events.map((x) => Math.round(x.time))))

  // 非法：/0/
  const f = H('/0/K/')
  T('/0/ 报错误诊断', f.diagnostics.some((x) => x.code === 'span-bad' && x.severity === 'error'), JSON.stringify(f.diagnostics.map((x) => x.code)))
}

// ============ 段落标记 # ============
console.log('\n=== 段落标记 # ===')

const MARK = parseChart(
  '[Settings]\nBookmarks = {114514, 1919810}\n\n' +
    T120 +
    DEF +
    '[Hitsound]\n' +
    '#123456\n' +
    '#2:03.456\n' +
    '#02:03.456\n' +
    '#2:03:456\n' +
    '#02:03:456\n' +
    '#bookmark(0)\n' +
    '#bookmark(1)\n' +
    '#timing(0)\n' +
    '/K/\n',
)
{
  const ms = MARK.markers
  T('段落标记：共解析出 8 个', ms.length === 8, 'n=' + ms.length)
  const t = (i: number) => (ms[i] ? ms[i].time : null)
  T('#123456 = 123456ms', t(0) === 123456, String(t(0)))
  T('#2:03.456 = 123456ms', t(1) === 123456, String(t(1)))
  T('#02:03.456 = 123456ms', t(2) === 123456, String(t(2)))
  T('#2:03:456 = 123456ms', t(3) === 123456, String(t(3)))
  T('#02:03:456 = 123456ms', t(4) === 123456, String(t(4)))
  T('#bookmark(0) = Bookmarks[0] = 114514', t(5) === 114514, String(t(5)))
  T('#bookmark(1) = Bookmarks[1] = 1919810', t(6) === 1919810, String(t(6)))
  T('#timing(0) = 0', t(7) === 0, String(t(7)))
  T('段落标记：全部解析成功（无 null）', ms.every((m) => m.time !== null && m.measure !== null), JSON.stringify(ms.map((m) => [m.raw, m.time])))
  // 最后一个标记是 #timing(0) -> 0ms，其后 /K/ 的时间应为 0
  T('标记后的音符从标记处继续', MARK.events.length === 1 && Math.abs(MARK.events[0].time) < 1, JSON.stringify(MARK.events.map((e) => Math.round(e.time))))
}

{
  // 注释仍然是 ##，单个 # 不再是注释
  const c = parseChart(T120 + DEF + '[Hitsound]\n## 这是注释\n/K K K K/\n')
  T('## 仍是注释（不产生标记、不报错）', c.markers.length === 0 && c.events.length === 4, 'markers=' + c.markers.length + ' events=' + c.events.length)

  const bad = parseChart(T120 + DEF + '[Hitsound]\n#bookmark(9)\n/K/\n')
  T('#bookmark 越界报错', bad.diagnostics.some((d) => d.code === 'marker-bad'), JSON.stringify(bad.diagnostics.map((d) => d.message)))
  const bad2 = parseChart(T120 + DEF + '[Hitsound]\n#timing(3)\n/K/\n')
  T('#timing 越界报错', bad2.diagnostics.some((d) => d.code === 'marker-bad'))
  const bad3 = parseChart(T120 + DEF + '[Hitsound]\n#abc\n/K/\n')
  T('#abc 无法识别时报错', bad3.diagnostics.some((d) => d.code === 'marker-bad'))
}

// ============ Bookmarks 设置项 ============
console.log('\n=== Bookmarks ===')

{
  const c = parseChart('[Settings]\nBookmarks={114514,1919810}\n\n' + T120 + DEF + '[Hitsound]\n/K/\n')
  T('Bookmarks 解析为数字数组', c.settings.Bookmarks.length === 2 && c.settings.Bookmarks[0] === 114514 && c.settings.Bookmarks[1] === 1919810, JSON.stringify(c.settings.Bookmarks))
  T('空 Bookmarks 不报错', (() => {
    const e = parseChart('[Settings]\nBookmarks={}\n\n' + T120 + DEF + '[Hitsound]\n/K/\n')
    return e.settings.Bookmarks.length === 0
  })())
  T('Bookmarks 里非数字报错', (() => {
    const e = parseChart('[Settings]\nBookmarks={abc}\n\n' + T120 + DEF + '[Hitsound]\n/K/\n')
    return e.diagnostics.some((d) => d.code === 'set-bookmarks')
  })())
}

// ============ 网格铺到歌曲结束 ============
console.log('\n=== 网格铺到歌曲结束 ===')

{
  const body = T120 + DEF + '[Hitsound]\n/K K K K/\n'
  const noAudio = parseChart(body)
  const withAudio = parseChart(body, { audioDurationMs: 180000 })
  T('无音频：网格只铺保底的 32 小节', noAudio.measures.length === 32, 'grid=' + noAudio.measures.length)
  T('有音频（180s）：网格铺过歌曲结束', withAudio.measures.length > 32 && withAudio.measures[withAudio.measures.length - 1].end >= 180000, 'grid=' + withAudio.measures.length + ' lastEnd=' + Math.round(withAudio.measures[withAudio.measures.length - 1].end))
  T('有音频：网格末尾恰好覆盖歌曲长度（不无限铺）', withAudio.measures[withAudio.measures.length - 1].end - 2000 < 180000, 'lastEnd=' + Math.round(withAudio.measures[withAudio.measures.length - 1].end))
}

// ============ .osu 的 [Editor] Bookmarks 导入/导出 ============
console.log('\n=== .osu Bookmarks 往返 ===')

{
  const osu = [
    'osu file format v14',
    '',
    '[General]',
    'AudioFilename: audio.mp3',
    'Mode: 0',
    '',
    '[Editor]',
    'DistanceSpacing: 1',
    'BeatDivisor: 4',
    'Bookmarks: 114514,1919810',
    '',
    '[Metadata]',
    'Title:Test',
    'Artist:Foo',
    '',
    '[TimingPoints]',
    '500,333.333333333333,4,2,1,60,1,0',
    '',
  ].join('\n')
  const imp = fromOsu(osu, TEMPLATE)
  T('导入：Bookmarks 数量 = 2', imp.bookmarksCount === 2, 'n=' + imp.bookmarksCount)
  T('导入：写入 [Settings] Bookmarks', /Bookmarks\s*=\s*\{114514,\s*1919810\}/.test(imp.text), (imp.text.match(/Bookmarks.*/) || [''])[0])
  const re = parseChart(imp.text)
  T('导入：再解析得到 2 个书签', re.settings.Bookmarks.length === 2, JSON.stringify(re.settings.Bookmarks))
  T('导入：结果无 error 诊断', !re.diagnostics.some((d) => d.severity === 'error'), JSON.stringify(re.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)))

  const out = toOsu(re)
  T('导出：[Editor] 写出 Bookmarks', /Bookmarks:\s*114514,1919810/.test(out), (out.match(/Bookmarks:.*/) || [''])[0])

  const none = fromOsu('[General]\nAudioFilename: a.mp3\n\n[Editor]\nBeatDivisor: 4\n\n[Metadata]\nTitle:T\n\n[TimingPoints]\n0,500,4,2,1,60,1,0\n', TEMPLATE)
  T('导入：没有 Bookmarks 时不写该项', none.bookmarksCount === 0 && !/Bookmarks\s*=\s*\{\s*\d/.test(none.text), 'n=' + none.bookmarksCount)
}


// ---------- Keysound ----------
{
  console.log('\n=== Keysound ===')
  // 音高换算
  T('音高：A4 = 69', midiOf('A', 4) === 69, String(midiOf('A', 4)))
  T('音高：A0 = 21（钢琴最低音）', midiOf('A', 0) === 21, String(midiOf('A', 0)))
  T('音高：C8 = 108（钢琴最高音）', midiOf('C', 8) === 108, String(midiOf('C', 8)))
  T('音高：midiToName(69) = A4', midiToName(69) === 'A4', midiToName(69))
  T('音高：midiToName(21) = A0', midiToName(21) === 'A0', midiToName(21))
  T('音高：nameToMidi("C8") = 108', nameToMidi('C8') === 108, String(nameToMidi('C8')))
  T('音高：A4 = 440Hz', Math.abs(freqOf(69) - 440) < 0.001, freqOf(69).toFixed(3))
  T('音高：A3 = 220Hz', Math.abs(freqOf(57) - 220) < 0.001, freqOf(57).toFixed(3))
  T('音高：H(=C#) 是黑键，C 不是', isBlackKey(midiOf('H', 4)!) && !isBlackKey(midiOf('C', 4)!))
  T('音高：一个八度 12 个半音', letterToSemi('B') === 11 && letterToSemi('C') === 0)

  // 路径模板展开（文档 0.3.1.2 的例子）
  // 注意：真实解析链路会先 unquote 再交给展开器
  const pan = unquote('"piano/<loop("A","L","B","C","H","D","I","E","F","J","G","K")><int((i+9)/12)>.wav"')
  const exp = expandKeysoundPath({
    pattern: pan,
    low: nameToMidi('A0')!,
    high: nameToMidi('C8')!,
    tune: 0,
    lists: new Map(),
  })
  T('模板：展开 88 个音高', exp.files.size === 88, String(exp.files.size))
  T('模板：MIDI 21 -> piano/A0.wav', String(exp.files.get(21)).endsWith('piano/A0.wav'), String(exp.files.get(21)))
  T('模板：MIDI 60 -> piano/C4.wav', String(exp.files.get(60)).endsWith('piano/C4.wav'), String(exp.files.get(60)))
  T('模板：MIDI 108 -> piano/C8.wav', String(exp.files.get(108)).endsWith('piano/C8.wav'), String(exp.files.get(108)))
  T('模板：无展开错误', exp.errors.length === 0, exp.errors.join(';'))

  // int 的位数补零
  const pad = expandKeysoundPath({ pattern: '<int(m,3)>.wav', low: 60, high: 62, tune: 0, lists: new Map() })
  T('模板：int 第二参数补零', pad.files.get(60) === '060.wav', String(pad.files.get(60)))

  // list 指令
  const byList = expandKeysoundPath({
    pattern: '<list(PN)><int(i/12)>.wav',
    low: 60,
    high: 61,
    tune: 0,
    lists: new Map([['PN', ['C', 'H', 'D']]]),
  })
  T('模板：list() 循环取值', byList.files.get(60) === 'C0.wav' && byList.files.get(61) === 'H0.wav', String(byList.files.get(60)) + '/' + String(byList.files.get(61)))

  // ---- 正文解析 ----
  const ks = parseChart(
    [
      '[Files]',
      'path = "D:/song"',
      'audio = "a.mp3"',
      '',
      '[Define]',
      'hitsound custom D = default.normal-hitnormal',
      'keysound custom piano = ("piano/<loop("A","L","B","C","H","D","I","E","F","J","G","K")><int((i+9)/12)>.wav", A0, C8)',
      '',
      '[Timing]',
      '0,bpm(120),4,0,0',
      '',
      '[Keysound]',
      '{piano}',
      '/4C D E F/',
      '/^G _C/',
      '/4A/',
      '',
      '[Hitsound]',
      '/D D D D/',
      '',
    ].join('\n'),
  )
  const kes = ks.events.filter((e) => e.kind === 'keysound')
  const pitches = kes.map((e) => e.pitch)
  console.log('keysound 音符：' + kes.map((e) => e.names[0] + '(' + e.pitch + ')').join(' '))
  T(
    '正文：乐器列表解析出 1 条谱表 piano',
    ks.keyInstruments.length === 1 && ks.keyInstruments[0].name === 'piano',
    JSON.stringify(ks.keyInstruments.map((i) => i.name)),
  )
  T('正文：keysound 音符数 = 7', kes.length === 7, String(kes.length))
  T(
    '正文：/4C D E F/ -> C4 D4 E4 F4',
    JSON.stringify(pitches.slice(0, 4)) === JSON.stringify([60, 62, 64, 65]),
    JSON.stringify(pitches.slice(0, 4)),
  )
  T('正文：^G 落在上一个音 +1~+12 内（G4=67）', pitches[4] === 67, String(pitches[4]))
  T('正文：_C 落在上一个音 -12~-1 内（C4=60）', pitches[5] === 60, String(pitches[5]))
  T('正文：/4A/ 绝对八度 -> A4=69', pitches[6] === 69, String(pitches[6]))
  T('正文：乐器名写到事件上', kes.every((e) => e.instrument === 'piano'), String(kes[0] && kes[0].instrument))
  const pno = ks.hitsounds.find((h) => h.kind === 'keysound' && h.name === 'piano')
  T('正文：piano 展开出 88 个音高的文件表', (pno && pno.keyFiles && pno.keyFiles.size) === 88, String(pno && pno.keyFiles && pno.keyFiles.size))
  T(
    '正文：hitsound 音符仍在同一个 events 里',
    ks.events.filter((e) => e.kind === 'hitsound').length === 4,
    String(ks.events.filter((e) => e.kind === 'hitsound').length),
  )
  T(
    '正文：无 error 诊断',
    !ks.diagnostics.some((d) => d.severity === 'error'),
    JSON.stringify(ks.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)),
  )

  // 时值数字 vs 八度数字
  const dur = parseChart(
    [
      '[Timing]',
      '0,bpm(120),4,0,0',
      '',
      '[Define]',
      'keysound custom piano = ("x.wav", C4, C4)',
      '',
      '[Keysound]',
      '{piano}',
      '/4C4/',
      '',
    ].join('\n'),
  )
  const dn = dur.events.filter((e) => e.kind === 'keysound')
  T('时值：/4C4/ 只产生 1 个音符（后面的 4 是时值）', dn.length === 1, String(dn.length))
  T('时值：该音符占满整小节 2000ms', dn.length === 1 && Math.abs(dn[0].duration - 2000) < 1, String(dn[0] && dn[0].duration))

  // 多谱表
  const multi = parseChart(
    [
      '[Timing]',
      '0,bpm(120),4,0,0',
      '',
      '[Define]',
      'keysound custom piano = ("x.wav", C4, C4)',
      '',
      '[Keysound]',
      '{piano}',
      '/4C | 3C/',
      '',
    ].join('\n'),
  )
  const ms = multi.events.filter((e) => e.kind === 'keysound')
  T(
    '多谱表：两个音同时开始、八度互不干扰（C4=60 / C3=48）',
    ms.length === 2 && ms.every((e) => e.time === ms[0].time) && ms.some((e) => e.pitch === 60) && ms.some((e) => e.pitch === 48),
    JSON.stringify(ms.map((e) => [e.staff, e.pitch])),
  )

  // 错误诊断
  const bad = parseChart('[Timing]\n0,bpm(120),4,0,0\n\n[Keysound]\n{piano}\n/4Q/\n')
  T('诊断：非法音符代号 Q 报错', bad.diagnostics.some((d) => d.code === 'ks-note'), JSON.stringify(bad.diagnostics.map((d) => d.code)))
  const badInst = parseChart('[Timing]\n0,bpm(120),4,0,0\n\n[Keysound]\n{nope}\n/4C/\n')
  T('诊断：未定义的乐器报错', badInst.diagnostics.some((d) => d.code === 'ks-undefined'), JSON.stringify(badInst.diagnostics.map((d) => d.code)))
  const badHead = parseChart('[Timing]\n0,bpm(120),4,0,0\n\n[Keysound]\n/4C/\n')
  T('诊断：缺少花括号乐器列表报错', badHead.diagnostics.some((d) => d.code === 'ks-instbad'), JSON.stringify(badHead.diagnostics.map((d) => d.code)))
  const badCaret = parseChart(
    '[Timing]\n0,bpm(120),4,0,0\n\n[Define]\nhitsound custom D = default.normal-hitnormal\n\n[Hitsound]\n/^D/\n',
  )
  T('诊断：[Hitsound] 里出现 ^ 报错', badCaret.diagnostics.some((d) => d.code === 'oct-outside'), JSON.stringify(badCaret.diagnostics.map((d) => d.code)))
}
