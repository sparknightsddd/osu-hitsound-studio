/**
 * 导出音效的设置（应用级）。
 *
 * 只存一件事：代号没有写死采样组时（`hitwhistle` / `hitclap` / `custom`），
 * 分配槽位的优先级。默认 sw > sf > sc > nw > nf > nc > dw > df > dc。
 */
import { DEFAULT_SLOT_ORDER, parseSlotKey } from './osuExport'

const KEY = 'hsstudio.export'

export interface ExportPrefs {
  /** 9 个 (set, hit) 槽位，靠前的优先 */
  slotOrder: string[]
  /**
   * 导出前删掉本谱之前生成的 `[[EZHS*]].osu`，
   * 避免每次导出都多出一个 `[EZHS1]`、`[EZHS2]`…
   */
  cleanOld: boolean
}

export function isValidOrder(list: string[]): boolean {
  return (
    list.length === DEFAULT_SLOT_ORDER.length &&
    new Set(list).size === list.length &&
    list.every((k) => !!parseSlotKey(k))
  )
}

const SET_LETTER: Record<string, 'soft' | 'normal' | 'drum'> = { s: 'soft', n: 'normal', d: 'drum' }
const HIT_LETTER: Record<string, 'hitwhistle' | 'hitfinish' | 'hitclap'> = {
  w: 'hitwhistle',
  f: 'hitfinish',
  c: 'hitclap',
}

/**
 * 把设置里写的槽位缩写变成标准名：
 * `sw` → `soft-hitwhistle`，也接受完整写法。
 */
export function normalizeSlotToken(tok: string): string | null {
  const t = tok.trim().toLowerCase()
  const direct = parseSlotKey(t)
  if (direct) return `${direct.set}-${direct.hit}`
  if (t.length === 2) {
    const set = SET_LETTER[t[0]]
    const hit = HIT_LETTER[t[1]]
    if (set && hit) return `${set}-${hit}`
  }
  return null
}

export function loadExportPrefs(): ExportPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const o = JSON.parse(raw)
      if (Array.isArray(o.slotOrder) && isValidOrder(o.slotOrder)) {
        return { slotOrder: o.slotOrder, cleanOld: !!o.cleanOld }
      }
    }
  } catch {
    /* 坏数据就当没设置过 */
  }
  return { slotOrder: [...DEFAULT_SLOT_ORDER], cleanOld: false }
}

export function saveExportPrefs(p: ExportPrefs) {
  localStorage.setItem(KEY, JSON.stringify({ slotOrder: p.slotOrder, cleanOld: !!p.cleanOld }))
}

/** 设置界面的输入格式：`sw, sf, sc, nw, nf, nc, dw, df, dc` */
export function orderToText(list: string[]): string {
  return list.join(', ')
}

export function textToOrder(text: string): string[] {
  return text
    .split(/[,，\s]+/)
    .map((s) => normalizeSlotToken(s))
    .filter((s): s is string => !!s)
}
