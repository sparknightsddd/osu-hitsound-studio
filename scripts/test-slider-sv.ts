/**
 * 滑条节点时间与 SV 继承规则：
 *   - 红线会把 SV 重置为 1，红线之前的绿线不能跨过红线继续生效；
 *   - 与红线同一时刻的绿线仍然有效；
 *   - 红线之后的新绿线按新 SV 计算；
 *   - BPM 用最后一条红线，SV 用「最后一条红线之后（含同刻）」的最后一条绿线。
 *
 * 这些时间会用于 .osu 导入时的滑条折返点/尾音效、物件时间轴和「写入 .osu」。
 */
import {
  parseTimingPoints,
  sliderNodeTimes,
  timingAt,
  type OsuTimingPoint,
} from '../src/core/osuSounds'

let pass = 0
let fail = 0
const T = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
}

const TP = (time: number, beatLength: number, uninherited: boolean): OsuTimingPoint => ({
  time,
  beatLength,
  meter: 4,
  sampleSet: 2,
  sampleIndex: 0,
  volume: 100,
  uninherited,
  effects: 0,
})

/** 120 BPM / SM 1.4 / 长度 140 → 一个来回正好 500ms（SV=1） */
const NODES = (tps: OsuTimingPoint[], at: number) => sliderNodeTimes(tps, at, 140, 1, 1.4)

// 1) 红线之前有 SV 0.5 的绿线；红线后没有新绿线 → 红线后必须回到 SV=1
{
  const tps = [TP(0, 500, true), TP(1000, -200, false), TP(2000, 500, true)]
  T('红线前：SV 0.5 生效', timingAt(tps, 1500).sv === 0.5, String(timingAt(tps, 1500).sv))
  T('红线后：SV 被重置为 1', timingAt(tps, 2500).sv === 1, String(timingAt(tps, 2500).sv))

  const nodes = NODES(tps, 2500)
  T('红线后的滑条尾按 SV=1 算（3000ms）', nodes[1] === 3000, nodes.join(','))
  T('旧算法会算成 3500ms（回归保护）', nodes[1] !== 3500, nodes.join(','))
}

// 2) 红线与绿线同一时刻：绿线有效
{
  const tps = [TP(0, 500, true), TP(2000, 500, true), TP(2000, -50, false)]
  T('同刻绿线：SV=2 生效', timingAt(tps, 2500).sv === 2, String(timingAt(tps, 2500).sv))
  const nodes = NODES(tps, 2500)
  T('同刻绿线：滑条尾 2750ms', nodes[1] === 2750, nodes.join(','))
}

// 3) 红线之后又来一条绿线：按新绿线算
{
  const tps = [TP(0, 500, true), TP(1000, -200, false), TP(2000, 500, true), TP(3000, -200, false)]
  T('红线后的绿线：SV=0.5 生效', timingAt(tps, 3500).sv === 0.5, String(timingAt(tps, 3500).sv))
  T('红线后的绿线：滑条尾 4500ms', NODES(tps, 3500)[1] === 4500, NODES(tps, 3500).join(','))
}

// 4) 红线同时换 BPM：beatLength 用新红线，SV 回到 1
{
  const tps = [TP(0, 500, true), TP(1000, -200, false), TP(2000, 250, true)]
  const at = timingAt(tps, 2500)
  T('红线换 BPM：beatLength=250', at.beatLength === 250, String(at.beatLength))
  T('红线换 BPM：SV 回到 1', at.sv === 1, String(at.sv))
  T('红线换 BPM：滑条尾 2750ms', NODES(tps, 2500)[1] === 2750, NODES(tps, 2500).join(','))
}

// 5) 多条绿线：取时间上最后一条（同刻则取解析顺序最后一条）
{
  const tps = [TP(0, 500, true), TP(1000, -200, false), TP(1000, -400, false)]
  T('同刻多条绿线取最后一条（SV=0.25）', timingAt(tps, 1500).sv === 0.25, String(timingAt(tps, 1500).sv))
  const later = [TP(0, 500, true), TP(1000, -200, false), TP(1500, -400, false)]
  T('不同时刻取最后一条（SV=0.25）', timingAt(later, 1600).sv === 0.25, String(timingAt(later, 1600).sv))
}

// 6) 没有红线（异常谱面）：仍能给出默认拍长，绿线 SV 生效
{
  const tps = [TP(0, -200, false)]
  const at = timingAt(tps, 100)
  T('无红线时拍长回落到 500', at.beatLength === 500, String(at.beatLength))
  T('无红线时绿线 SV 仍生效', at.sv === 0.5, String(at.sv))
}

// 7) 解析 .osu 的 [TimingPoints]：uninherited 判定与排序
{
  const tps = parseTimingPoints([
    '0,500,4,2,0,100,1,0',
    '2000,500,4,2,0,100,1,0',
    '2000,-50,4,2,0,100,0,0',
    '1000,-200,4,2,0,100,0,0',
  ])
  T('解析出 4 条 Timing', tps.length === 4, String(tps.length))
  T('按时间排序后红线在前、同刻绿线在后', tps[1].time === 1000 && tps[2].uninherited && !tps[3].uninherited, tps.map((p) => `${p.time}:${p.uninherited ? 'R' : 'G'}`).join(' '))
  T('同刻红线+绿线：SV=2', timingAt(tps, 2500).sv === 2, String(timingAt(tps, 2500).sv))
}

console.log(`\nRESULT ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
