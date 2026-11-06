/**
 * 音效颜色：[Define] 里可选的第五段（`hitsound <槽位> <代号> = <路径> <颜色>`）。
 *
 * 支持两种写法，二选一：
 *   - 色号：`#FF0000`（也接受 `#f00`）
 *   - 英文名：`red` / `green` / `blue` / `yellow` / `purple` …（CSS 基本色名表）
 *
 * 解析时统一归一化成 `#rrggbb` 小写，渲染层直接用。
 */

/** CSS 颜色名 → 十六进制（取 CSS 标准值） */
export const NAMED_COLORS: Record<string, string> = {
  black: '#000000',
  silver: '#c0c0c0',
  gray: '#808080',
  grey: '#808080',
  white: '#ffffff',
  maroon: '#800000',
  red: '#ff0000',
  purple: '#800080',
  fuchsia: '#ff00ff',
  magenta: '#ff00ff',
  green: '#008000',
  lime: '#00ff00',
  olive: '#808000',
  yellow: '#ffff00',
  navy: '#000080',
  blue: '#0000ff',
  teal: '#008080',
  aqua: '#00ffff',
  cyan: '#00ffff',
  orange: '#ffa500',
  gold: '#ffd700',
  brown: '#a52a2a',
  pink: '#ffc0cb',
  hotpink: '#ff69b4',
  salmon: '#fa8072',
  coral: '#ff7f50',
  crimson: '#dc143c',
  indigo: '#4b0082',
  violet: '#ee82ee',
  turquoise: '#40e0d0',
  skyblue: '#87ceeb',
  steelblue: '#4682b4',
  royalblue: '#4169e1',
  slateblue: '#6a5acd',
  tan: '#d2b48c',
  khaki: '#f0e68c',
  beige: '#f5f5dc',
  lavender: '#e6e6fa',
  plum: '#dda0dd',
  orchid: '#da70d6',
  tomato: '#ff6347',
  chocolate: '#d2691e',
  firebrick: '#b22222',
  seagreen: '#2e8b57',
  forestgreen: '#228b22',
  springgreen: '#00ff7f',
  chartreuse: '#7fff00',
  dodgerblue: '#1e90ff',
  deepskyblue: '#00bfff',
}

/** 把用户写的颜色 token 归一化成 `#rrggbb`；不是合法颜色返回 null */
export function parseColorToken(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s)
  if (hex) {
    const h = hex[1].toLowerCase()
    return h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : `#${h}`
  }
  const name = NAMED_COLORS[s.toLowerCase()]
  return name || null
}

/** 渲染用：#rrggbb → [r,g,b]；失败返回 null */
export function colorToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * 按音量算不透明度（写进八位色号的最后两位）。
 * 100 → 0xFF(255)、0 → 0x37(55)，中间线性。
 */
export function alphaForVolume(volume: number): number {
  const v = Math.max(0, Math.min(100, volume))
  return (0x37 + ((0xff - 0x37) * v) / 100) / 255
}

/** `rgb()` 字符串：带 alpha 时用 rgba */
export function cssColor(hex: string, alpha = 1): string {
  const rgb = colorToRgb(hex)
  if (!rgb) return hex
  if (alpha >= 1) return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha.toFixed(3)})`
}
