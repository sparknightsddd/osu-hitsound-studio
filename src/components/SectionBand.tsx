/**
 * 格子视图里的分节符横条：左边可编辑的段落名，最右侧是 MuseScore 风格的换行标识。
 *
 * 位置/高度由父组件给（夹在两行之间），这里只管交互：
 *   - 点横条空白 → 聚焦段落名输入框
 *   - 输入后失焦 / Enter → 提交名称
 *   - 点右侧标识 → 聚焦它；再按 Backspace / Delete → 删除分节符
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

interface Props {
  time: number
  name: string
  height: number
  /** 刚创建的分节符：自动聚焦名称输入框 */
  autoFocus: boolean
  onFocused: () => void
  onRename: (time: number, name: string) => void
  onDelete: (time: number) => void
}

export default function SectionBand({ time, name, height, autoFocus, onFocused, onRename, onDelete }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const markRef = useRef<HTMLButtonElement>(null)
  const [value, setValue] = useState(name)
  /** 正在输入时不要被 props.name 覆盖 */
  const editing = useRef(false)
  const focusedCb = useRef(onFocused)
  focusedCb.current = onFocused

  useEffect(() => {
    if (!editing.current) setValue(name)
  }, [name])

  useEffect(() => {
    if (!autoFocus) return
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.select()
    focusedCb.current()
  }, [autoFocus])

  const commit = () => {
    editing.current = false
    const v = value.trim()
    if (v !== name) onRename(time, v)
  }

  const onNameKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.currentTarget.blur()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setValue(name)
      e.currentTarget.blur()
    }
  }

  return (
    <div
      className="gd-section"
      style={{ height }}
      onMouseDown={(e) => {
        const t = e.target as HTMLElement
        if (t.closest('input, button')) return
        e.preventDefault()
        inputRef.current?.focus()
      }}
      title="分节符：点击空白处输入段落名称"
    >
      <div className="gd-section-dash" />
      <input
        ref={inputRef}
        className="gd-section-name"
        value={value}
        placeholder="点击输入段落名称"
        spellCheck={false}
        onChange={(e) => {
          editing.current = true
          setValue(e.target.value)
        }}
        onFocus={() => {
          editing.current = true
        }}
        onBlur={commit}
        onKeyDown={onNameKey}
      />
      <span className="gd-section-spacer" />
      <button
        ref={markRef}
        type="button"
        className="gd-section-mark"
        title="分节符：点一下再按 Backspace / Delete 删除"
        onMouseDown={(e) => {
          // 不让按钮默认抢焦点（有的平台点击不聚焦），手动来
          e.preventDefault()
          markRef.current?.focus()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Backspace' || e.key === 'Delete') {
            e.preventDefault()
            e.stopPropagation()
            onDelete(time)
          }
        }}
      >
        {/* MuseScore 3 的换行标识：虚线框 + 回弯箭头 */}
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
          <rect
            x="2"
            y="2"
            width="16"
            height="16"
            rx="2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            strokeDasharray="2.4 2.4"
            opacity="0.85"
          />
          <path
            d="M14.5 6.2 V11 H7.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M9.8 8.4 6.8 11 9.8 13.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  )
}
