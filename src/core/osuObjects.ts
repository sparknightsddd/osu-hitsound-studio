/**
 * 读取 .osu 的物件时间轴（只读，用于网格模式在格子下方对照原谱）。
 *
 * 只关心三类物件与它们的起止时间：
 *   - circle   ：一个点，start = end
 *   - slider   ：start 到最后一节的尾巴（用 SliderMultiplier + 绿线 SV 换算）
 *   - spinner  ：start 到 endTime
 * 物件本身的坐标 / 折线形状不参与显示 —— 这里画的是时间轴示意图。
 */
import {
  osuKV,
  osuSections,
  parseHitObjects,
  parseTimingPoints,
  sliderNodeTimes,
} from './osuSounds'

export type OsuObjectKind = 'circle' | 'slider' | 'spinner'

export interface OsuTimelineObject {
  kind: OsuObjectKind
  /** 毫秒 */
  start: number
  /** 毫秒；circle 与 start 相同 */
  end: number
  /** 滑条段数：1 = 不折返，2 = 来回一次（1 个折返点），3 = 两个折返点… */
  spans?: number
}

export interface OsuTimeline {
  objects: OsuTimelineObject[]
  /** 解析失败时的原因（对象仍可能为空数组） */
  error?: string
}

/** 把一份 .osu 文本解析成按时间排序的物件时间轴 */
export function parseOsuTimeline(src: string): OsuTimeline {
  const sec = osuSections(src)
  const lines = sec.get('hitobjects')
  if (!lines || !lines.length) return { objects: [], error: '没有 [HitObjects] 段（可能不是完整谱面）' }

  const diff = osuKV(sec.get('difficulty'))
  const sliderMultiplier = Number(diff.SliderMultiplier) || 1
  const tps = parseTimingPoints(sec.get('timingpoints'))
  const raw = parseHitObjects(lines)

  const objects: OsuTimelineObject[] = []
  for (const o of raw) {
    if ((o.type & 8) === 8) {
      // spinner：objectParams 第一项就是结束时间
      const end = Number((o.objectParams.split(',')[0] || '').trim())
      objects.push({ kind: 'spinner', start: o.time, end: Number.isFinite(end) && end > o.time ? end : o.time })
    } else if ((o.type & 2) === 2) {
      // slider：curve, slides, length, ...
      const p = o.objectParams.split(',')
      const slides = Math.max(1, Number(p[1]) || 1)
      const length = Number(p[2]) || 0
      const times = sliderNodeTimes(tps, o.time, length, slides, sliderMultiplier)
      const end = times[times.length - 1]
      objects.push({
        kind: 'slider',
        start: o.time,
        end: Number.isFinite(end) && end > o.time ? end : o.time,
        spans: slides,
      })
    } else if ((o.type & 1) === 1) {
      objects.push({ kind: 'circle', start: o.time, end: o.time })
    }
    // type & 128（mania 长条）不画：本程序的谱面模式里没有对应的形状
  }
  objects.sort((a, b) => a.start - b.start)
  if (!objects.length) return { objects: [], error: '没有 circle / slider / spinner 物件' }
  return { objects }
}
