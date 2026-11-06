import { useStore } from '../store'
import { IconClose } from './Icons'
import { saveActive } from '../core/actions'
import { t } from '../i18n'

export default function TabsBar() {
  const files = useStore((s) => s.files)
  const activeId = useStore((s) => s.activeId)
  const setActive = useStore((s) => s.setActive)
  const closeFile = useStore((s) => s.closeFile)
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
          {/* 未保存标记：点关闭按钮会换成"要保存吗"的圆点 */}
          {f.dirty ? (
            <button
              className="x dirty"
              title={t('有未保存改动，点击保存')}
              onClick={(e) => {
                e.stopPropagation()
                void saveActive(false)
              }}
            >
              ●
            </button>
          ) : (
            <button
              className="x"
              onClick={(e) => {
                e.stopPropagation()
                closeFile(f.id)
              }}
            >
              <IconClose className="sm" />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
