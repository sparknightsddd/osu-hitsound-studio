/**
 * 审阅：三个只读的谱面体检报告。
 *
 * - 音效使用次数统计：每个代号在正文里响了几次、第一次/最后一次在哪
 * - 槽位冲突检测：怎么排都排不出合法槽位的叠音组合（导出时会直接报错跳过）
 * - 重复槽位音效检测：同一时刻有多个音效落在同一个槽位上（导出时要混音）
 *
 * 后两项都带「每一次落点」的时间，界面里点时间就能跳到时间轴。
 * 全是纯函数，不碰 store、不写文件。
 */
import type { ChartDoc } from './types'
import {
  DEFAULT_SLOT_ORDER,
  collectCombos,
  detectSlotConflicts,
  planOsuExport,
  type SlotConflictReport,
} from './osuExport'

// ---------------------------------------------------------------------------
// 1) 音效使用次数
// ---------------------------------------------------------------------------

export interface UsageRow {
  code: string
  /** 响了几次：同一个格子里 [A B] 各算一次，同一刻只算一次 */
  count: number
  /** 第一次 / 最后一次（毫秒）；没用过为 null */
  first: number | null
  last: number | null
  color?: string
  /** [Define] 里的槽位（custom / soft-hitclap …） */
  slots: string[]
  /** 正文里用到但 [Define] 里没有这条 */
  defined: boolean
  /** 键音（keysound）：不参与 .osu 导出，单独计数 */
  keysound: boolean
  /** 定义指向的文件名（显示用） */
  file: string
}

export interface UsageReport {
  rows: UsageRow[]
  /** 所有代号加起来的次数（一格两个代号算 2 次） */
  totalHits: number
  /** 不同时刻的落点数 */
  totalMoments: number
  /** 用到的代号数（count > 0） */
  used: number
  /** [Define] 里定义了却一次没用 */
  unused: number
  /** 正文里用到但没定义的代号 */
  undefinedNames: string[]
}

export function usageReport(doc: ChartDoc): UsageReport {
  const stat = new Map<string, { count: number; first: number; last: number }>()
  const bump = (name: string, t: number) => {
    if (!name) return
    const cur = stat.get(name)
    if (cur) {
      cur.count++
      if (t < cur.first) cur.first = t
      if (t > cur.last) cur.last = t
    } else {
      stat.set(name, { count: 1, first: t, last: t })
    }
  }

  // hitsound：和导出一样按「时刻」合并叠音，[A B] 各算一次
  const { occurrences } = collectCombos(doc)
  for (const occ of occurrences) {
    for (const n of occ.combo.names) bump(n, occ.time)
  }

  // keysound：每个音符单独算一次（不参与导出，但确实被用到了）
  let keysoundNotes = 0
  for (const e of doc.events) {
    if (e.kind !== 'keysound') continue
    keysoundNotes++
    for (const n of e.names) bump(n, Math.floor(e.time))
  }

  const rows: UsageRow[] = []
  const seen = new Set<string>()
  for (const h of doc.hitsounds) {
    if (!h.name || seen.has(h.name)) continue
    seen.add(h.name)
    const st = stat.get(h.name)
    rows.push({
      code: h.name,
      count: st?.count ?? 0,
      first: st?.first ?? null,
      last: st?.last ?? null,
      color: h.color,
      slots: [
        ...h.alts.map((a) => (a.custom ? 'custom' : `${a.sampleSet}-${a.hitType}`)),
        ...(h.subSlots || []),
      ],
      defined: true,
      keysound: h.kind === 'keysound',
      file: (h.resolvedPath || '').split(/[\\/]/).pop() || '',
    })
  }
  // 正文里用到、但 [Define] 里没有的代号
  for (const [name, st] of stat) {
    if (seen.has(name)) continue
    seen.add(name)
    rows.push({
      code: name,
      count: st.count,
      first: st.first,
      last: st.last,
      slots: [],
      defined: false,
      keysound: false,
      file: '',
    })
  }

  rows.sort(
    (a, b) =>
      b.count - a.count ||
      (a.first ?? Number.MAX_SAFE_INTEGER) - (b.first ?? Number.MAX_SAFE_INTEGER) ||
      a.code.localeCompare(b.code),
  )

  let totalHits = 0
  for (const r of rows) totalHits += r.count
  return {
    rows,
    totalHits,
    totalMoments: occurrences.length + keysoundNotes,
    used: rows.filter((r) => r.count > 0).length,
    unused: rows.filter((r) => r.defined && r.count === 0).length,
    undefinedNames: rows.filter((r) => !r.defined).map((r) => r.code),
  }
}

// ---------------------------------------------------------------------------
// 2) 槽位冲突
// ---------------------------------------------------------------------------

export type { SlotConflictReport }

export function slotConflictReport(doc: ChartDoc, slotOrder?: string[]): SlotConflictReport[] {
  return detectSlotConflicts(doc, slotOrder?.length ? slotOrder : DEFAULT_SLOT_ORDER)
}

// ---------------------------------------------------------------------------
// 3) 重复槽位音效（到导出时必须混音的那些）
// ---------------------------------------------------------------------------

export interface DupSlotRow {
  /** 导出后的文件名，如 soft-hitclap2.wav */
  to: string
  /** 挤在同一个槽位上的代号（可能是 [Aa Ab]） */
  codes: string[]
  /** 这些时刻该槽位上有多个音效（毫秒，升序） */
  times: number[]
  /** 落到哪个音效组编号 */
  index: number
}

export interface DupSlotReport {
  rows: DupSlotRow[]
  /** 导出计划里的硬错误（代号没定义、没有合法槽位…），有的话先修再谈混音 */
  errors: string[]
  /** 一共用到几个音效组编号 */
  groups: number
}

export function dupSlotReport(doc: ChartDoc, slotOrder?: string[]): DupSlotReport {
  const plan = planOsuExport(doc, {
    slotOrder: slotOrder?.length ? slotOrder : DEFAULT_SLOT_ORDER,
  })
  const rows: DupSlotRow[] = []
  for (const f of plan.files) {
    if (!f.mix) continue
    const src = f.mixMeta?.sources || []
    rows.push({
      to: f.to,
      codes: src.map((s) => s.code),
      times: f.mixTimes || [],
      index: src[0]?.index ?? 0,
    })
  }
  rows.sort((a, b) => (a.times[0] ?? 0) - (b.times[0] ?? 0) || a.to.localeCompare(b.to))
  return { rows, errors: plan.errors, groups: plan.groups.length }
}
