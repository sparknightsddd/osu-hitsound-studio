/**
 * 从 .osu 导入音效时的「白板 / 代号」设置框。
 *
 * 白板 = 正文里什么都没标（休止符）时对应的那个音效。给它选一条之后：
 *   - 它不再有代号，正文里命中的位置直接留空；
 *   - [Define] 里写一条无名定义（`hitsound <槽位> = <值>`）；
 *   - 编辑器试听时休止符不发声。
 * 其余音效每条都能自定义代号，输入框只保留英文字母、大小写原样（`abc` / `ABc` / `aBc`
 * 都合法）；输入单个数字或符号会转成正文里的名字（`1` → `One`、`/` → `Slash`，`=` 除外）。
 *
 * 和难度选择器一样用「模块级单例 + 独立订阅」，由 actions 在需要时 open()。
 */
import { useEffect, useRef, useState } from 'react'
import type { SoundCode } from '../core/osuSounds'
import { soundCodeKey } from '../core/osuSounds'
import { normalizeCodeInput } from '../core/codes'
import { buildDefaultNames } from '../core/importPrefs'
import { t } from '../i18n'

export interface SoundImportPlan {
  /** 白板音效的 key；空串 = 不使用白板 */
  whiteboard: string
  /** 非白板音效的代号：key -> name */
  names: Record<string, string>
}

export interface SoundImportRow {
  code: SoundCode
  key: string
  /** 该音效在谱面里出现的次数 */
  count: number
}

type Resolver = (plan: SoundImportPlan | null) => void

let resolver: Resolver | null = null
let currentRows: SoundImportRow[] = []
let currentFile = ''
let currentWb = ''
/** 来自「设置 → 导入默认代号」的预置：key -> 代号 */
let currentPreset: Record<string, string> = {}

const subs = new Set<() => void>()
function emit() {
  subs.forEach((f) => f())
}

/** 把用户输入规整成代号：只留字母、大小写原样；单个数字/符号转成 One / Slash */
export function normalizeSoundName(raw: string): string {
  return normalizeCodeInput(raw)
}

/**
 * 打开设置框。`suggestedWhiteboard` 是默认选中的白板 key（传空 = 默认不用白板）。
 * 用户确认后返回 { whiteboard, names }；取消返回 null。
 */
export function pickSoundPlan(
  rows: SoundImportRow[],
  fileName: string,
  preset: { whiteboard?: string; names?: Record<string, string> } = {},
): Promise<SoundImportPlan | null> {
  return new Promise((resolve) => {
    resolver = resolve
    currentRows = rows
    currentFile = fileName
    currentWb = preset.whiteboard || ''
    currentPreset = preset.names || {}
    emit()
  })
}

function finish(plan: SoundImportPlan | null) {
  const r = resolver
  resolver = null
  currentRows = []
  emit()
  if (r) r(plan)
}

export default function SoundImportDialog() {
  const [, force] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const [wb, setWb] = useState('')
  const [names, setNames] = useState<Record<string, string>>({})

  useEffect(() => {
    const f = () => force((n) => n + 1)
    subs.add(f)
    return () => {
      subs.delete(f)
    }
  }, [])

  const isOpen = !!resolver
  useEffect(() => {
    if (!isOpen) return
    setWb(currentWb)
    setNames(buildDefaultNames(currentRows, currentWb, currentPreset))
    box.current?.focus()
  }, [isOpen])

  if (!isOpen) return null

  // 校验：非白板行必须非空且不重复
  const seen = new Map<string, string>()
  let error = ''
  for (const r of currentRows) {
    if (r.key === wb) continue
    const n = names[r.key] || ''
    if (!n) {
      error = t('每个非白板音效都要填代号')
      break
    }
    if (seen.has(n)) {
      error = t('代号 {name} 重复了', { name: n })
      break
    }
    seen.set(n, r.key)
  }

  const submit = () => {
    if (error) return
    const out: Record<string, string> = {}
    for (const r of currentRows) if (r.key !== wb) out[r.key] = names[r.key]
    finish({ whiteboard: wb, names: out })
  }

  const changeWb = (key: string) => {
    setWb(key)
    // 从白板变回普通音效时，如果还没有代号就补一个默认的
    if (key && !names[key])
      setNames((m) => ({ ...m, [key]: buildDefaultNames(currentRows, key, currentPreset)[key] || '' }))
  }

  return (
    <div
      className="osu-diff-overlay"
      onMouseDown={() => finish(null)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') finish(null)
      }}
    >
      <div
        className="osu-diff si-dialog"
        tabIndex={-1}
        ref={box}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="osu-diff-head">
          {t('设置音效白板与代号')}
          <span className="osu-diff-sub">{currentFile.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}</span>
        </div>

        <div className="si-tip">
          <b>{t('白板')}</b> {t('= 正文里什么都没写（休止符）时对应的音效。选中后它不再有代号，正文命中的位置直接留空；试听时休止符不发声。')}
          <span className="si-sum">
            {t('共 {n} 个音效', { n: currentRows.length })}
            {wb ? t('；白板：{name}', { name: currentRows.find((r) => r.key === wb)?.code.slot || '' }) : t('；未设白板，全部保留代号')}
          </span>
        </div>

        <div className="osu-diff-list">
          <label className="si-none">
            <input type="radio" checked={wb === ''} onChange={() => changeWb('')} />
            <span>{t('不使用白板（所有音效都保留代号）')}</span>
          </label>
          {currentRows.map((r) => {
            const isWb = r.key === wb
            return (
              <div key={r.key} className={`si-row ${isWb ? 'is-wb' : ''}`}>
                <input
                  type="radio"
                  name="si-wb"
                  title={t('设为白板')}
                  checked={isWb}
                  onChange={() => changeWb(r.key)}
                />
                <input
                  className="si-code-input mono"
                  value={isWb ? '' : names[r.key] || ''}
                  disabled={isWb}
                  placeholder={isWb ? t('无代号') : t('代号')}
                  maxLength={16}
                  spellCheck={false}
                  onChange={(e) =>
                    setNames((m) => ({
                      ...m,
                      [r.key]: normalizeSoundName(e.target.value),
                    }))
                  }
                />
                <div className="si-meta">
                  <span className="si-slot">
                    {r.code.slot}
                    {isWb && <span className="si-badge">{t('白板 · 不写代号')}</span>}
                  </span>
                  <span className="si-file">{r.code.file ? r.code.file : r.code.value}</span>
                </div>
                <span className="si-count">{r.count} {t('次')}</span>
              </div>
            )
          })}
        </div>

        <div className="osu-diff-foot">
          <span className={`osu-diff-hint ${error ? 'si-err' : ''}`}>
            {error || t('代号只能用英文字母，大小写不限；数字/符号会写成 One / Slash（Esc 取消）')}
          </span>
          <div className="si-actions">
            <button className="osu-diff-cancel" onClick={() => finish(null)}>
              {t('取消')}
            </button>
            <button className="si-ok" disabled={!!error} onClick={submit}>
              {t('导入')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 统计每个代码出现的次数（给设置框显示） */
export function countCodes(codes: SoundCode[], sounds: { code: SoundCode }[]): Map<string, number> {
  const keys = new Map<SoundCode, string>()
  for (const c of codes) keys.set(c, soundCodeKey(c))
  const out = new Map<string, number>()
  for (const s of sounds) {
    const k = keys.get(s.code) || soundCodeKey(s.code)
    out.set(k, (out.get(k) || 0) + 1)
  }
  return out
}
