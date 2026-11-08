import { useStore } from '../store'
import { IconClose } from './Icons'
import { closeChart } from '../core/actions'
import { t } from '../i18n'

export default function TabsBar() {
  const files = useStore((s) => s.files)
  const activeId = useStore((s) => s.activeId)
  const setActive = useStore((s) => s.setActive)
  return (
    <div className="tabs">
      {files.map((f) => (
        <div
          key={f.id}
          className={`tab ${f.id === activeId ? 'on' : ''}`}
          onClick={() => setActive(f.id)}
          title={f.path ? `${f.path}${f.dirty ? t('（有未保存改动）') : ''}` : f.name}
        >
          <span className="name">{f.name}</span>
          {/*
            未保存时显示圆点（和 VSCode 一样），鼠标移到标签上再变成 ×。
            两种状态点下去都是「关闭」，有改动会问 保存 / 不保存 / 取消。
          */}
          <button
            className={`x${f.dirty ? ' dirty' : ''}`}
            title={f.dirty ? t('有未保存改动，点击关闭时会问是否保存') : t('关闭')}
            onClick={(e) => {
              e.stopPropagation()
              void closeChart(f.id)
            }}
          >
            {f.dirty ? <i className="dot" /> : null}
            <IconClose className="sm" />
          </button>
        </div>
      ))}
    </div>
  )
}
