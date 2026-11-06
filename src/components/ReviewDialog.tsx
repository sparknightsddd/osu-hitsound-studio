/**
 * 审阅：音效使用次数 / 槽位冲突 / 重复槽位音效。
 *
 * 和设置、添加音效一样用「模块级开关 + 独立订阅」，菜单里调 openReview(kind)。
 * 三页都是只读报告；后两页的每个时间都是一个按钮，点一下就把播放头挪过去
 * 并打开底部时间轴（再关掉本窗口，免得挡住）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { engine } from '../audio/engine'
import { fmtOsuTime } from '../core/time'
import { revealTime } from '../core/reveal'
import { dupSlotReport, slotConflictReport, usageReport } from '../core/review'
import { loadExportPrefs } from '../core/exportPrefs'
import { t as tr } from '../i18n'

export type ReviewKind = 'usage' | 'conflict' | 'dup'

const TABS: { id: ReviewKind; label: string; sub: string }[] = [
  { id: 'usage', label: '使用次数', sub: '音效使用次数统计 —— 每个代号响了几次、第一次 / 最后一次在哪' },
  { id: 'conflict', label: '槽位冲突', sub: '槽位冲突检测 —— 怎么排都排不出合法槽位的叠音组合' },
  { id: 'dup', label: '重复槽位', sub: '重复槽位音效检测 —— 同一时刻挤在同一个槽位上、导出时要混音的地方' },
]

let opened: ReviewKind | null = null
const subs = new Set<() => void>()
function emit() {
  subs.forEach((f) => f())
}

/** 打开审阅，kind 决定先看哪一页 */
export function openReview(kind: ReviewKind = 'usage') {
  opened = kind
  emit()
}

function closeReview() {
  opened = null
  emit()
}

// 自动化调试用：生产构建也挂上，CDP 可以直接打开审阅窗
;(window as any).__openReview = openReview

/** 最多先摆几个时间，剩下的点「展开全部」 */
const TIME_HEAD = 8

/** 写剪贴板：桌面/浏览器都先试 navigator.clipboard，失败退回 execCommand */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

export default function ReviewDialog() {
  const [, force] = useState(0)
  const doc = useStore((s) => s.doc)
  const [tab, setTab] = useState<ReviewKind>('usage')
  const [showAll, setShowAll] = useState<Set<string>>(new Set())
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const f = () => force((n) => n + 1)
    subs.add(f)
    return () => {
      subs.delete(f)
    }
  }, [])

  const kind = opened
  useEffect(() => {
    if (!kind) return
    setTab(kind)
    setShowAll(new Set())
    box.current?.focus()
  }, [kind])

  /** 一次算完三份：切页不用等，标签上的角标也能直接显示 */
  const report = useMemo(() => {
    if (!kind) return null
    const order = loadExportPrefs().slotOrder
    return {
      usage: usageReport(doc),
      conflicts: slotConflictReport(doc, order),
      dup: dupSlotReport(doc, order),
    }
  }, [kind, doc])

  if (!kind || !report) return null

  const active = TABS.find((t) => t.id === tab) || TABS[0]
  const counts: Record<ReviewKind, number> = {
    usage: report.usage.rows.length,
    conflict: report.conflicts.length,
    dup: report.dup.rows.length,
  }

  /** 点时间：播放头挪过去 + 打开时间轴 + 把视野滚到那儿，然后关掉本窗口 */
  const jump = (t: number) => {
    engine.seek(t)
    if (useStore.getState().panel !== 'timeline' || !useStore.getState().panelOpen) {
      useStore.setState({ panel: 'timeline', panelOpen: true })
    }
    revealTime(t)
    closeReview()
  }

  const toggleAll = (key: string) => {
    setShowAll((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** 后两页的「复制清单」：纯文本，方便贴到别处对照 */
  const listText = (): string => {
    if (tab === 'conflict') {
      return report.conflicts
        .map((c) => `[${c.names.join(' ')}]（${c.count} 处）\n  ${c.reason}\n  ${c.times.map(fmtOsuTime).join('、')}`)
        .join('\n')
    }
    return report.dup.rows
      .map((r) => `${r.to}（${r.codes.map((c) => c || tr('白板')).join(' + ')}）\n  ${r.times.map(fmtOsuTime).join('、')}`)
      .join('\n')
  }

  const doCopy = async () => {
    const ok = await copyText(listText())
    useStore.getState().log(ok ? '✓ 已复制审阅清单到剪贴板' : '✗ 复制失败（剪贴板不可用）')
  }

  return (
    <div
      className="osu-diff-overlay"
      onMouseDown={closeReview}
      onKeyDown={(e) => {
        if (e.key === 'Escape') closeReview()
      }}
    >
      <div className="osu-diff rv-dialog" tabIndex={-1} ref={box} onMouseDown={(e) => e.stopPropagation()}>
        <div className="osu-diff-head">
          {tr('审阅')}
          <span className="osu-diff-sub">{tr(active.sub)}</span>
        </div>

        <div className="set-tabs rv-tabs" role="tablist">
          {TABS.map((tabDef) => (
            <button
              key={tabDef.id}
              role="tab"
              aria-selected={tabDef.id === tab}
              className={`set-tab${tabDef.id === tab ? ' on' : ''}`}
              onClick={() => setTab(tabDef.id)}
            >
              {tr(tabDef.label)}
              <i className={`rv-badge${counts[tabDef.id] ? '' : ' zero'}`}>{counts[tabDef.id]}</i>
            </button>
          ))}
        </div>

        <div className="rv-body">
          {tab === 'usage' ? (
            <>
              <div className="rv-sum">
                <span>
                  {tr('共')} <b>{report.usage.rows.length}</b> {tr('个代号')}
                </span>
                <span>
                  {tr('用到 {n} 个', { n: report.usage.used })}
                </span>
                <span>
                  {tr('总落笔')} <b>{report.usage.totalHits}</b> {tr('次')} · {report.usage.totalMoments} {tr('个时刻')}
                </span>
                {report.usage.unused ? <span className="rv-dim">{tr('未使用 {n} 个', { n: report.usage.unused })}</span> : null}
                {report.usage.undefinedNames.length ? (
                  <span className="rv-warn">{tr('正文用到但没定义 {n} 个', { n: report.usage.undefinedNames.length })}</span>
                ) : null}
              </div>

              {report.usage.rows.length ? (
                <div className="rv-table">
                  <div className="rv-thead">
                    <span>{tr('代号')}</span>
                    <span>{tr('槽位')}</span>
                    <span />
                    <span className="num">{tr('次数')}</span>
                    <span>{tr('首次')}</span>
                    <span>{tr('末次')}</span>
                  </div>
                  {report.usage.rows.map((r) => {
                    const max = Math.max(1, report.usage.rows[0]?.count || 1)
                    const pct = r.count ? Math.max(2, (r.count / max) * 100) : 0
                    return (
                      <div
                        key={r.code}
                        className={`rv-row${r.count ? '' : ' off'}${r.defined ? '' : ' bad'}`}
                        title={r.file ? `${r.code} → ${r.file}` : r.code}
                      >
                        <span className="rv-code">
                          <i className="rv-dot" style={{ background: r.color || 'var(--accent)' }} />
                          <span className="mono">{r.code}</span>
                          {!r.defined ? <em className="rv-tag bad">{tr('未定义')}</em> : null}
                          {r.defined && !r.count ? <em className="rv-tag">{tr('未使用')}</em> : null}
                          {r.keysound ? <em className="rv-tag">{tr('键音')}</em> : null}
                        </span>
                        <span className="rv-slots mono" title={r.slots.join(' | ')}>
                          {r.slots.join(' | ') || '—'}
                        </span>
                        <span className="rv-freq">
                          <i style={{ width: `${pct}%` }} />
                        </span>
                        <span className="rv-num mono">{r.count}</span>
                        <span className="rv-time">
                          {r.first != null ? (
                            <button className="rv-chip mono" onClick={() => jump(r.first!)}>
                              {fmtOsuTime(r.first)}
                            </button>
                          ) : (
                            <span className="rv-dim">—</span>
                          )}
                        </span>
                        <span className="rv-time">
                          {r.last != null && r.last !== r.first ? (
                            <button className="rv-chip mono" onClick={() => jump(r.last!)}>
                              {fmtOsuTime(r.last)}
                            </button>
                          ) : (
                            <span className="rv-dim">{r.first != null ? '同上' : '—'}</span>
                          )}
                        </span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="rv-empty">{tr('这份谱还没有任何音效 —— 先在 [Define] 里定义、在正文里落笔')}</div>
              )}
            </>
          ) : null}

          {tab === 'conflict' ? (
            report.conflicts.length ? (
              <>
                <div className="rv-sum">
                  <span className="rv-warn">{report.conflicts.length} 个叠音组合排不出合法槽位</span>
                  <span className="rv-dim">{tr('导出时这些组合会被跳过，先改 [Define]')}</span>
                </div>
                {report.conflicts.map((c) => {
                  const key = c.names.join('+')
                  const all = showAll.has(key)
                  const times = all ? c.times : c.times.slice(0, TIME_HEAD)
                  return (
                    <div key={key} className="rv-card">
                      <div className="rv-card-head">
                        <em className="rv-tag bad">{tr('冲突')}</em>
                        <span className="mono rv-names">[{c.names.join(' ')}]</span>
                        <span className="rv-dim">{c.count} 处</span>
                      </div>
                      <div className="rv-reason">{c.reason}</div>
                      <div className="rv-times">
                        {times.map((t, i) => (
                          <button key={i} className="rv-chip mono" onClick={() => jump(t)} title={tr('跳到时间轴')}>
                            {fmtOsuTime(t)}
                          </button>
                        ))}
                        {c.times.length > TIME_HEAD ? (
                          <button className="rv-more" onClick={() => toggleAll(key)}>
                            {all ? '收起' : `展开全部（${c.times.length}）`}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  )
                })}
              </>
            ) : (
              <div className="rv-empty ok">
                <span className="rv-ok-mark">✓</span>
                没有槽位冲突 —— 这份谱里所有叠音组合都能排出合法槽位
              </div>
            )
          ) : null}

          {tab === 'dup' ? (
            <>
              {report.dup.errors.length ? (
                <div className="rv-note">
                  <b>导出计划里还有 {report.dup.errors.length} 个问题</b>
                  <span className="rv-dim">{tr('（这些会先挡住导出，混音清单可能不完整）')}</span>
                  {report.dup.errors.slice(0, 5).map((e, i) => (
                    <div key={i} className="rv-err mono">
                      {e}
                    </div>
                  ))}
                  {report.dup.errors.length > 5 ? (
                    <div className="rv-dim">…还有 {report.dup.errors.length - 5} 条</div>
                  ) : null}
                </div>
              ) : null}

              {report.dup.rows.length ? (
                <>
                  <div className="rv-sum">
                    <span>
                      <b>{report.dup.rows.length}</b> 个槽位需要混音
                    </span>
                    <span>
                      共 <b>{report.dup.rows.reduce((n, r) => n + r.times.length, 0)}</b> 处重复槽位音效
                    </span>
                    <span className="rv-dim">{tr('导出时会写 HSSM，重新导入能拆回代号')}</span>
                  </div>
                  {report.dup.rows.map((r) => {
                    const key = `dup:${r.to}`
                    const all = showAll.has(key)
                    const times = all ? r.times : r.times.slice(0, TIME_HEAD)
                    return (
                      <div key={key} className="rv-card">
                        <div className="rv-card-head">
                          <em className="rv-tag warn">{tr('混音')}</em>
                          <span className="mono rv-names">{r.to}</span>
                          <span className="mono rv-dim">#{r.index}</span>
                          <span className="rv-dim">{r.times.length} 处</span>
                        </div>
                        <div className="rv-reason">
                          <span className="mono">[{r.codes.map((c) => c || tr('白板')).join(' + ')}]</span>{' '}
                          挤在同一个槽位上
                        </div>
                        <div className="rv-times">
                          {times.map((t, i) => (
                            <button key={i} className="rv-chip mono" onClick={() => jump(t)} title={tr('跳到时间轴')}>
                              {fmtOsuTime(t)}
                            </button>
                          ))}
                          {r.times.length > TIME_HEAD ? (
                            <button className="rv-more" onClick={() => toggleAll(key)}>
                              {all ? tr('收起') : tr('展开全部（{n}）', { n: r.times.length })}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    )
                  })}
                </>
              ) : (
                <div className="rv-empty ok">
                  <span className="rv-ok-mark">✓</span>
                  {tr('没有重复槽位音效 —— 每个槽位在任意时刻最多只有一个音效')}
                </div>
              )}
            </>
          ) : null}
        </div>

        <div className="osu-diff-foot">
          <span className="osu-diff-hint">
            {tab === 'usage'
              ? tr('点时间可以跳到时间轴；次数按「时刻」算，一格里的 [A B] 各计一次')
              : tr('点时间会跳到时间轴并关掉本窗口')}
          </span>
          <div className="si-actions">
            {tab !== 'usage' && listText() ? (
              <button className="osu-diff-cancel" onClick={() => void doCopy()}>
                {tr('复制清单')}
              </button>
            ) : null}
            <button className="si-ok" onClick={closeReview}>
              {tr('关闭')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
