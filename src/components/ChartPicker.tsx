/**
 * 「把音效复制到其他谱面」的谱面选择器。
 *
 * 列出当前已经打开的谱面（顶部标签栏里的那些，排除源谱面），
 * 选中后由调用方切换过去并用 `pickAddSound()` 弹出预填好的代号/槽位窗口。
 *
 * 和难度选择器一样用「模块级单例 + 独立订阅」，由 actions 里 await。
 */
import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n'

export interface ChartPickItem {
  id: string
  name: string
  /** 磁盘路径（没存过盘的谱面为空） */
  path?: string
  /** 已有代号数 / 事件数，给用户一点判断依据 */
  defines: number
  events: number
}

export interface ChartPickOptions {
  /** 标题里带一句「将音效 Aa 复制到…」 */
  title?: string
  charts: ChartPickItem[]
}

type Resolver = (id: string | null) => void
let resolver: Resolver | null = null
let opts: ChartPickOptions = { charts: [] }

const subs = new Set<() => void>()
function emit() {
  subs.forEach((f) => f())
}

export function pickChart(o: ChartPickOptions): Promise<string | null> {
  return new Promise((resolve) => {
    resolver = resolve
    opts = o
    emit()
  })
}

function finish(id: string | null) {
  const r = resolver
  resolver = null
  emit()
  if (r) r(id)
}

export default function ChartPicker() {
  const [, force] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const f = () => force((n) => n + 1)
    subs.add(f)
    return () => {
      subs.delete(f)
    }
  }, [])

  const isOpen = !!resolver
  useEffect(() => {
    if (isOpen) box.current?.focus()
  }, [isOpen])

  if (!isOpen) return null

  return (
    <div
      className="osu-diff-overlay"
      onMouseDown={() => finish(null)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') finish(null)
      }}
    >
      <div className="osu-diff chart-pick" tabIndex={-1} ref={box} onMouseDown={(e) => e.stopPropagation()}>
        <div className="osu-diff-head">
          {opts.title || t('选择要复制到的谱面')}
          <span className="osu-diff-sub">{t('只列出已经打开的谱面')}</span>
        </div>
        <div className="osu-diff-list">
          {opts.charts.length === 0 && <div className="osu-diff-empty">{t('没有其他打开的谱面')}</div>}
          {opts.charts.map((c) => (
            <button key={c.id} className="osu-diff-row chart-pick-row" onClick={() => finish(c.id)}>
              <span className="osu-diff-name">{c.name}</span>
              <span className="osu-diff-meta">{c.path || t('（未保存到磁盘，仅内存）')}</span>
              <span className="osu-diff-meta2">
                {c.defines} {t('个音效代号')} · {c.events} {t('个事件')}
              </span>
            </button>
          ))}
        </div>
        <div className="osu-diff-foot">
          <span className="osu-diff-hint">{t('Esc 或点击空白处 = 取消')}</span>
          <button className="osu-diff-cancel" onClick={() => finish(null)}>
            {t('取消')}
          </button>
        </div>
      </div>
    </div>
  )
}
