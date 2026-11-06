/**
 * 通用右键菜单（文本编辑 / 格子编辑共用）。
 *
 * 用模块级的 openEditMenu 打开，宿主组件挂在 App 最外层：
 * 这样 CodeMirror 和 GridEditor 都不需要自己管浮层定位/关闭。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface EditMenuItem {
  label: string
  /** 右侧的快捷键提示 */
  hint?: string
  disabled?: boolean
  danger?: boolean
  /** 在这一项前面画一条分隔线 */
  sep?: boolean
  onClick: () => void
}

interface MenuState {
  x: number
  y: number
  items: EditMenuItem[]
}

let openSetter: ((s: MenuState | null) => void) | null = null

export function openEditMenu(x: number, y: number, items: EditMenuItem[]) {
  openSetter?.({ x, y, items })
}

export function closeEditMenu() {
  openSetter?.(null)
}

export default function EditMenuHost() {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    openSetter = setMenu
    return () => {
      if (openSetter === setMenu) openSetter = null
    }
  }, [])

  // 打开时按视口边界校正（在绘制前完成，不会闪一下）
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el || !menu) return
    const r = el.getBoundingClientRect()
    el.style.left = `${Math.max(6, Math.min(menu.x, window.innerWidth - r.width - 6))}px`
    el.style.top = `${Math.max(6, Math.min(menu.y, window.innerHeight - r.height - 6))}px`
    el.style.visibility = 'visible'
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const close = (e?: Event) => {
      // 点菜单本身不算「点外面」（菜单项的 mousedown 不能先把菜单卸掉）
      if (e && boxRef.current?.contains(e.target as Node)) return
      setMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setMenu(null)
      }
    }
    const onBlur = () => setMenu(null)
    window.addEventListener('mousedown', close, true)
    window.addEventListener('contextmenu', close, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', onBlur)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('contextmenu', close, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', onBlur)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  if (!menu) return null

  // 位置/显隐全部由 useLayoutEffect 直接写 style：如果放在 style prop 里，
  // 父组件每次重渲染都会把 left/top 重置回原点，并把 visibility 重新设成 hidden。
  return (
    <div
      className="edit-menu"
      ref={boxRef}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((it, i) => (
        <div key={`${it.label}:${i}`}>
          {it.sep ? <div className="edit-menu-sep" /> : null}
          <div
            className={`edit-menu-item${it.disabled ? ' disabled' : ''}${it.danger ? ' danger' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (it.disabled) return
              setMenu(null)
              it.onClick()
            }}
          >
            <span>{it.label}</span>
            {it.hint ? <span className="hint">{it.hint}</span> : null}
          </div>
        </div>
      ))}
    </div>
  )
}
