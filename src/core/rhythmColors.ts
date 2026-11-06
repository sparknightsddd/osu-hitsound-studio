/**
 * 节奏刻度的分类与配色。
 *
 * 时间轴（细分网格线）和格子视图（格子边框）共用这一套：
 * 同一时刻的同一等分，在两种视图里颜色必须一致，否则看起来像两套网格。
 */

export type Priority = 'beat' | 'half' | 'third' | 'quarter' | 'eighth' | 'other'

/** 依优先级判定某等分刻度属于哪一类（整拍 > 1/2 > 1/3,1/6 > 1/4 > 1/8 > 其它） */
export function tickPriority(i: number, n: number): Priority {
  if (i % n === 0) return 'beat'
  if ((i * 2) % n === 0) return 'half'
  if ((i * 3) % n === 0 || (i * 6) % n === 0) return 'third'
  if ((i * 4) % n === 0) return 'quarter'
  if ((i * 8) % n === 0) return 'eighth'
  return 'other'
}

export interface RhythmPalette {
  beat: string
  half: string
  third: string
  quarter: string
  eighth: string
  other: string
  /** 播放头 */
  playhead: string
}

export function rhythmPalette(theme: 'light' | 'dark'): RhythmPalette {
  // 各等分刻度的颜色（黑=整拍，不参与调色；其余按"色调保留但明度往背景靠近"原则调浅）
  return theme === 'dark'
    ? {
        beat: '#f0f0f0',
        half: '#ff8a85', // 浅珊瑚：避免与蓝色光标撞色
        third: '#d4baff',
        quarter: '#85c4ff',
        eighth: '#ffe28a',
        other: '#7a7a7a',
        // 播放头：青色系，与红线/蓝/紫都有明显色相差
        playhead: '#3ec5ff',
      }
    : {
        beat: '#161616',
        half: '#e87770', // 浅珊瑚
        third: '#b48ae0',
        quarter: '#6ba6e0',
        eighth: '#d9b758',
        other: '#b8b8b8',
        // 播放头：深青蓝
        playhead: '#0a85d6',
      }
}

/**
 * 线宽：普通拍（次/打/次）细线；每小节第一拍（动）另用 DOWNBEAT_WIDTH。
 * 格子视图用的是 CSS 边框的整数像素（1 / 2），这里是时间轴 canvas 的宽度。
 */
export const PRIORITY_WIDTH: Record<Priority, number> = {
  beat: 1.3,
  half: 1.1,
  third: 1,
  quarter: 1,
  eighth: 1,
  other: 1,
}

/** 每小节第一拍（“动”）的线宽：比普通拍明显粗一档 */
export const DOWNBEAT_WIDTH = 3

/** 不透明度：整拍最实，越细越淡 */
export const PRIORITY_ALPHA: Record<Priority, number> = {
  beat: 1,
  half: 0.75,
  third: 0.7,
  quarter: 0.6,
  eighth: 0.45,
  other: 0.28,
}

/** 时间轴里每个优先级的最小像素间距（低于则跳过，避免过密） */
export const PRIORITY_MIN_PX: Record<Priority, number> = {
  beat: 0,
  half: 10,
  third: 6,
  quarter: 5,
  eighth: 4,
  other: 8,
}

/** #rrggbb + 0~1 → rgba(...)（格子边框用；CSS 变量的 color-mix 在 canvas 里用不了） */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const a = Math.max(0, Math.min(1, alpha))
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a.toFixed(3)})`
}

/** 文字用黑还是白：按背景色的相对亮度挑对比度高的一边 */
export function readableOn(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return '#fff'
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  // sRGB 相对亮度（近似用 gamma 2.2 幂）
  const lum = 0.2126 * Math.pow(r / 255, 2.2) + 0.7152 * Math.pow(g / 255, 2.2) + 0.0722 * Math.pow(b / 255, 2.2)
  return lum > 0.45 ? '#101010' : '#ffffff'
}
