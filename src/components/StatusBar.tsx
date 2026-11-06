import { selectResolvedTheme, useStore } from '../store'
import { engine } from '../audio/engine'
import { fmtOsuTime } from '../core/time'
import { t } from '../i18n'


export default function StatusBar() {
  const doc = useStore((s) => s.doc)
  const cursor = useStore((s) => s.cursor)
  const themePref = useStore((s) => s.theme)
  const resolvedTheme = useStore(selectResolvedTheme)
  const setTheme = useStore((s) => s.setTheme)
  const panel = useStore((s) => s.panel)
  const setPanel = useStore((s) => s.setPanel)
  const setSidebar = useStore((s) => s.setSidebar)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const errors = doc.diagnostics.filter((d) => d.severity === 'error').length
  const warns = doc.diagnostics.filter((d) => d.severity === 'warning').length
  const bpm = doc.timing.length ? 60000 / doc.timing[0].beatLength : 0
  return (
    <div className="statusbar">
      <span className="item">
        {t('行 {line}，列 {col}', { line: cursor.line, col: cursor.col })}
        {cursor.sel ? t('（已选 {n}）', { n: cursor.sel }) : ''}
      </span>
      <span className="item click" onClick={() => setPanel('problems')}>
        <span className={errors ? 'err' : ''}>✖ {errors}</span>
        <span className={warns ? 'warn' : ''}>⚠ {warns}</span>
      </span>
      <span className="item">♪ {doc.events.length} {t('音符')}</span>
      <span className="item">▤ {doc.usedMeasures} {t('小节')}</span>
      {bpm > 0 && <span className="item">{bpm.toFixed(1)} BPM</span>}
      <span className="spacer" />
      {engine.songName ? (
        <span className="item">♫ {engine.songName}</span>
      ) : (
        <span
          className={`item click ${doc.audioPath ? 'warn' : ''}`}
          title={
            doc.audioPath
              ? t('谱面指定的音频：{path}（浏览器读不到本地路径，点这里选中目录自动配对）', { path: doc.audioPath })
              : t('点这里选择本地音频')
          }
          onClick={() => {
            setSidebar('audio')
            if (!sidebarOpen) toggleSidebar()
          }}
        >
          {doc.audioPath ? t('⚠ 未载入歌曲 · 点击载入') : t('未载入歌曲')}
        </span>
      )}
      <span className="item click" onClick={() => setPanel(panel === 'timeline' ? 'problems' : 'timeline')}>
        {t('时间轴')}
      </span>
      <span
        className="item click"
        title={t('点击切换深浅色 · 「跟随系统」在 设定 → 外观 里选')}
        onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
      >
        {themePref === 'auto'
          ? t('主题: 自动·{mode}', { mode: t(resolvedTheme === 'dark' ? '深' : '浅') })
          : themePref === 'dark'
            ? t('主题: 深色')
            : t('主题: 浅色')}
      </span>
      <span className="item">{fmtOsuTime(engine.nowMs())}</span>
    </div>
  )
}
