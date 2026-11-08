/**
 * 「添加到 [Define]」的弹窗：选槽位（可多选，不选就是 custom）+ 填代号。
 *
 * 和难度选择器 / 导入设置一样用「模块级单例 + 独立订阅」，
 * 由音效库的 + 按钮 await pickAddSound(...)。
 */
import { Fragment, useEffect, useRef, useState } from 'react'
import { normalizeSoundName } from './SoundImportDialog'
import { parseColorToken } from '../core/colors'
import { isCodeName } from '../core/codes'
import { t } from '../i18n'

export interface AddSoundPlan {
  /** 选中的槽位（可能为空 → 调用方写 custom） */
  slots: string[]
  /** 代号（英文字母，大小写不限） */
  name: string
  /** 可选颜色，已归一化成 #rrggbb；没填就是 undefined（用默认色） */
  color?: string
}

/** 谱面里某个代号现在的定义（用来做「替换」提示与沿用槽位） */
export interface ExistingDef {
  /** 当前槽位（custom 就是空数组） */
  slots: string[]
  /** 当前的自定义颜色（#rrggbb），没有就是 undefined */
  color?: string
  /** 当前那一行的样子，展示用 */
  line: string
}

export interface AddSoundOptions {
  fileName: string
  /**
   * 写进 [Define] 的右值，只影响预览那一行。
   * 默认是 `"文件名"`；内置默认音效传 `default.xxx`（不加引号）。
   */
  value?: string
  /** 谱面里已经用掉的代号 → 当前定义；填了这些代号就是「替换」 */
  existing: Record<string, ExistingDef>
  /**
   * 打开时预填的内容。
   * 「把音效复制到其他谱面」用它把源谱的代号/槽位/颜色直接带过来。
   */
  initial?: {
    name?: string
    slots?: string[]
    color?: string
  }
}

const SETS = ['soft', 'normal', 'drum'] as const
const HITS = ['hitnormal', 'hitwhistle', 'hitfinish', 'hitclap'] as const

type Resolver = (plan: AddSoundPlan | null) => void
let resolver: Resolver | null = null
let opts: AddSoundOptions = { fileName: '', existing: {} }

const subs = new Set<() => void>()
function emit() {
  subs.forEach((f) => f())
}

export function pickAddSound(o: AddSoundOptions): Promise<AddSoundPlan | null> {
  return new Promise((resolve) => {
    resolver = resolve
    opts = o
    emit()
  })
}

function finish(plan: AddSoundPlan | null) {
  const r = resolver
  resolver = null
  emit()
  if (r) r(plan)
}

export default function AddSoundDialog() {
  const [, force] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const [slots, setSlots] = useState<string[]>([])
  const [name, setName] = useState('')
  const [colorText, setColorText] = useState('')
  /** 用户手动动过槽位勾选没有：没动过就让槽位跟着代号走（替换已用代号时沿用它的槽位） */
  const slotsTouched = useRef(false)
  /** 颜色同理：没手动改过就沿用已用代号原来的颜色 */
  const colorTouched = useRef(false)

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
    // 跨谱面复制：源谱的代号/槽位/颜色原样带过来
    const init = opts.initial
    setSlots(init?.slots ? [...init.slots] : [])
    setName(init?.name ?? '')
    setColorText(init?.color ? init.color.toUpperCase() : '')
    slotsTouched.current = !!init?.slots?.length
    colorTouched.current = !!init?.color
    box.current?.focus()
  }, [isOpen])

  if (!isOpen) return null

  const toggle = (slot: string) => {
    slotsTouched.current = true
    setSlots((list) => (list.includes(slot) ? list.filter((s) => s !== slot) : [...list, slot]))
  }

  /**
   * 换代号：没手动改过槽位/颜色时，自动带上这个代号原来的，这样「替换」只换了文件，
   * 槽位映射和配色都保留下来。
   */
  const changeName = (raw: string) => {
    const next = normalizeSoundName(raw)
    setName(next)
    const old = next ? opts.existing[next] : undefined
    if (!slotsTouched.current) setSlots(old?.slots ?? [])
    if (!colorTouched.current) setColorText(old?.color ? old.color.toUpperCase() : '')
  }

  const nm = name.trim()
  // 没填代号不算「错误」，只是还不能确定 —— 不再在底部喊「代号不能为空」，
  // 那样和输入框里的灰字提示叠在一起容易让人以为填过了。
  const color = parseColorToken(colorText)
  let error = ''
  if (nm && !isCodeName(nm)) error = t('代号只能用英文字母，大小写不限')
  else if (colorText.trim() && !color) error = t('颜色看不懂：写 #RRGGBB 或 red / green / blue…')
  const canOk = !!nm && !error
  /** 这个代号已经用过：确认后是替换，不是新加 */
  const replacing = nm ? opts.existing[nm] : undefined

  const value = slots.length ? slots.join('|') : 'custom'
  const pct = color ? color.toUpperCase() : ''

  return (
    <div
      className="osu-diff-overlay"
      onMouseDown={() => finish(null)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') finish(null)
        if (e.key === 'Enter' && canOk)
          finish({
            slots: slots.length ? slots : ['custom'],
            name: nm,
            color: color || undefined,
          })
      }}
    >
      <div className="osu-diff as-dialog" tabIndex={-1} ref={box} onMouseDown={(e) => e.stopPropagation()}>
        <div className="osu-diff-head">
          {replacing ? t('替换 [Define] 里的音效') : t('添加到 [Define]')}
          <span className="osu-diff-sub mono">{opts.fileName}</span>
        </div>

        <div className="si-tip">
          {t('勾选这个音效要占用的')}<b>{t('槽位')}</b>{t('（可多选，多个会用')} <span className="mono">|</span> {t('连起来）；')}
          <b>{t('一个都不勾就是 custom')}</b>{t('，正文里只能用代号调用。')}
        </div>

        {/* 行 = soft / normal / drum，列 = hitnormal / hitwhistle / hitfinish / hitclap，
            直接摊平成 5×4 网格；每个格子只放勾选框，名字由行列标题给出。 */}
        <div className="as-slots">
          <div className="as-corner" />
          {HITS.map((h) => (
            <div key={h} className="as-col">
              {h}
            </div>
          ))}
          {SETS.map((s) => (
            <Fragment key={s}>
              <div className="as-row">{s}</div>
              {HITS.map((h) => {
                const slot = `${s}-${h}`
                const on = slots.includes(slot)
                return (
                  <label key={slot} className={`as-cell ${on ? 'on' : ''}`} title={slot}>
                    <input type="checkbox" checked={on} onChange={() => toggle(slot)} />
                  </label>
                )
              })}
            </Fragment>
          ))}
        </div>

        <div className="as-name">
          <label>{t('代号')}</label>
          <input
            className="si-code-input mono"
            value={name}
            placeholder=""
            maxLength={16}
            spellCheck={false}
            onChange={(e) => changeName(e.target.value)}
          />
          <span className="hint">{t('字母大小写不限；数字/符号写成 One / Slash 这样的名字（网格里显示 1、/）')}</span>
        </div>

        <div className="as-name">
          <label>{t('颜色')}</label>
          <input
            className="si-code-input mono"
            value={colorText}
            placeholder={t('留空 = 默认色')}
            spellCheck={false}
            onChange={(e) => {
              colorTouched.current = true
              setColorText(e.target.value)
            }}
            onBlur={() => {
              // 失焦时把 red / #f00 归一成 #RRGGBB，认不出来就原样留着（下面会报错）
              const c = parseColorToken(colorText)
              if (c) setColorText(c.toUpperCase())
            }}
          />
          <input
            type="color"
            className={`as-swatch ${pct ? '' : 'is-empty'}`}
            title={pct || t('默认色（点一下挑一个）')}
            value={pct || '#7aa2f7'}
            onChange={(e) => {
              colorTouched.current = true
              setColorText(e.target.value.toUpperCase())
            }}
          />
          {pct ? (
            <button
              className="as-color-clear"
              onClick={() => {
                colorTouched.current = true
                setColorText('')
              }}
              title="改回默认色"
            >
              {t('默认')}
            </button>
          ) : null}
          <span className="hint as-color-hint">{t('#RRGGBB 或 red / green…')}</span>
        </div>

        {replacing ? (
          <div className="as-preview as-old mono" title={t('这一条现在长这样')}>
            <span className="as-tag">{t('原来')}</span>
            <s>{replacing.line}</s>
          </div>
        ) : null}
        <div className={`as-preview mono${replacing ? ' as-new' : ''}`}>
          {replacing ? <span className="as-tag">{t('换成')}</span> : null}
          hitsound {value} {nm || '<代号>'} = {opts.value ?? `"${opts.fileName}"`}{pct ? ` ${pct}` : ''}
        </div>

        <div className="osu-diff-foot">
          <span className={`osu-diff-hint ${error ? 'si-err' : ''}`}>
            {error ||
              (replacing
                ? t('代号 {name} 已经用过 → 确定 = 替换它（正文里引用它的地方都会换成新音效）', { name: nm })
                : canOk
                  ? t('Enter = 确定，Esc = 取消')
                  : t('先填个代号'))}
          </span>
          <div className="si-actions">
            <button className="osu-diff-cancel" onClick={() => finish(null)}>
              {t('取消')}
            </button>
            <button
              className="si-ok"
              disabled={!canOk}
              onClick={() =>
                finish({
                  slots: slots.length ? slots : ['custom'],
                  name: nm,
                  color: color || undefined,
                })
              }
            >
              {t('确定')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
