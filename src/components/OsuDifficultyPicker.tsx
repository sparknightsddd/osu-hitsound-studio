/**
 * 难度选择器。
 *
 * 从 .osu 导入音效时，一个歌曲目录里通常有五六个难度，需要让用户明确挑一个。
 * 这里用一个极小的独立订阅（不塞进 zustand store），由 actions 在需要时 open()，
 * 用户选定后 resolve 出该 .osu 的路径。
 */
import { useEffect, useRef, useState } from 'react'
import { desktopApi, type OsuDifficultyInfo } from '../core/desktop'
import { t } from '../i18n'

type Resolver = (path: string | null) => void

let resolver: Resolver | null = null
let currentFile = ''
let currentList: OsuDifficultyInfo[] = []

const subs = new Set<() => void>()
function emit() {
  subs.forEach((f) => f())
}

/**
 * 打开难度选择器。返回用户选中的 .osu 路径；取消或目录里只有这一个难度时直接返回它。
 */
export function pickOsuDifficulty(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    resolver = resolve
    currentFile = filePath
    currentList = []
    emit()
    const api = desktopApi()
    // 浏览器里拿不到同目录列表，直接用用户选中的那份
    if (!api) {
      finish(filePath)
      return
    }
    void api.listOsuDifficulties(filePath).then((r) => {
      if (resolver !== resolve) return
      const list = r.difficulties || []
      currentList = list
      emit()
      // 目录里只有这一个难度就不用打扰用户了
      if (list.length <= 1) finish(filePath)
    })
  })
}

function finish(path: string | null) {
  const r = resolver
  resolver = null
  currentList = []
  emit()
  if (r) r(path)
}

export default function OsuDifficultyPicker() {
  const [, force] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const f = () => force((n) => n + 1)
    subs.add(f)
    return () => {
      subs.delete(f)
    }
  }, [])

  // 打开时把焦点移进对话框，Esc 才能被这里接住
  useEffect(() => {
    if (resolver) box.current?.focus()
  })

  const api = desktopApi()
  const list = currentList
  const isOpen = !!resolver
  if (!isOpen || !api) return null

  const doImport = (p: string) => finish(p)

  return (
    <div
      className="osu-diff-overlay"
      onMouseDown={() => finish(null)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') finish(null)
      }}
    >
      <div className="osu-diff" tabIndex={-1} ref={box} onMouseDown={(e) => e.stopPropagation()}>
        <div className="osu-diff-head">
          {t('选择要导入的难度')}
          <span className="osu-diff-sub">{currentFile.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}</span>
        </div>
        <div className="osu-diff-list">
          {list.length === 0 && <div className="osu-diff-empty">{t('正在读取难度…')}</div>}
          {list.map((d) => (
            <button key={d.path} className="osu-diff-row" onClick={() => void doImport(d.path)}>
              <span className="osu-diff-name">{d.version}</span>
              <span className="osu-diff-meta">
                {d.title || d.name}
                {d.artist ? ` / ${d.artist}` : ''}
              </span>
              <span className="osu-diff-meta2">
                {d.objectCount ? `${d.objectCount} ${t('物件')}` : t('物件数未知')}
                {d.starRating ? ` · ${d.starRating.toFixed(2)}★` : ''}
                {d.hp ? ` · HP ${d.hp}` : ''}
                {d.cs ? ` · CS ${d.cs}` : ''}
                {d.ar ? ` · AR ${d.ar}` : ''}
                {d.od ? ` · OD ${d.od}` : ''}
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