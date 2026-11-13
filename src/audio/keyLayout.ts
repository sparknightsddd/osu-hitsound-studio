/** 一个乐器「MIDI 音高 → 用哪个 buffer、变调倍率、增益」的映射 */
export interface KeyLayoutEntry {
  /** engine 里的 buffer 名 */
  buffer: string
  /** playbackRate（相对根音） */
  rate: number
  /** 线性增益（0~4） */
  gain: number
}
