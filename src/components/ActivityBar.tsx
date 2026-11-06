import { selectResolvedTheme, useStore } from '../store'
import { IconAudio, IconFiles, IconMapset, IconSettings, IconSound, IconTimeline } from './Icons'
import { t } from '../i18n'

export default function ActivityBar() {
  const sidebar = useStore((s) => s.sidebar)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const setSidebar = useStore((s) => s.setSidebar)
  const setPanel = useStore((s) => s.setPanel)
  const resolvedTheme = useStore(selectResolvedTheme)
  const setTheme = useStore((s) => s.setTheme)
  const items = [
    { id: 'explorer' as const, icon: IconFiles, title: t('资源管理器 (Ctrl+B)') },
    { id: 'mapsets' as const, icon: IconMapset, title: t('谱面库 · osu! Songs（点一下直接导入）') },
    { id: 'sounds' as const, icon: IconSound, title: t('音效库 · 试听并添加到 [Define]') },
    { id: 'audio' as const, icon: IconAudio, title: t('音频与试听') },
    { id: 'settings' as const, icon: IconSettings, title: t('设定') },
  ]
  return (
    <div className="activitybar">
      {items.map((it) => (
        <button
          key={it.id}
          className={sidebar === it.id && sidebarOpen ? 'on' : ''}
          title={it.title}
          onClick={() => setSidebar(it.id)}
        >
          <it.icon />
        </button>
      ))}
      <button title={t('时间轴')} onClick={() => setPanel('timeline')}>
        <IconTimeline />
      </button>
      <div className="spacer" />
      <button
        title={t('切换深浅色主题（当前：{mode}）', { mode: t(resolvedTheme === 'dark' ? '深' : '浅') })}
        onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
      >
        <svg className="i" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="4.5" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
        </svg>
      </button>
    </div>
  )
}
