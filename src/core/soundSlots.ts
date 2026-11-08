/**
 * osu! 的 12 个音效槽位（采样组 × 打击类型），以及「从文件名猜槽位」。
 *
 * 文件名规则来自 osu! 本体：`soft-hitnormal.wav`、`normal-hitclap.ogg`……
 * 内置默认音效在编辑器里写作 `default.soft-hitnormal`，去掉 `default.` 也是同一个槽位。
 */
export const SLOT_SETS = ['soft', 'normal', 'drum'] as const
export const SLOT_HITS = ['hitnormal', 'hitwhistle', 'hitfinish', 'hitclap'] as const

export type SlotSet = (typeof SLOT_SETS)[number]
export type SlotHit = (typeof SLOT_HITS)[number]

export const ALL_SLOTS: string[] = SLOT_SETS.flatMap((s) => SLOT_HITS.map((h) => `${s}-${h}`))

export function isSlotName(v: string): boolean {
  return ALL_SLOTS.includes(v)
}

/**
 * 从文件名 / 引用名里认出槽位：
 *   `soft-hitnormal.wav` → `soft-hitnormal`
 *   `default.normal-hitclap` → `normal-hitclap`
 * 认不出返回 null（`clap.wav`、`hitnormal.wav` 这种没写采样组的都不算）。
 */
export function slotFromFileName(name: string): string | null {
  let base = String(name || '').replace(/^.*[\\/]/, '')
  base = base.replace(/\.(wav|ogg|mp3)$/i, '').trim()
  if (/^default\./i.test(base)) base = base.slice('default.'.length)
  const low = base.toLowerCase()
  return isSlotName(low) ? low : null
}
