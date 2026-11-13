import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { engine } from '../audio/engine'
import { IconLogo } from './Icons'
import {
  bundleSoundsToChartDir,
  exportCsv,
  exportJson,
  exportOsu,
  exportOsuPackage,
  exportTxt,
  newChart,
  openChartDir,
  openDemo,
  openFiles,
  openChartFolder,
  importOsu,
  importOsuSounds,
  saveActive,
  writeOsuHitsounds,
} from '../core/actions'
import { isDesktop } from '../core/desktop'
import { openAppSettings } from './AppSettingsDialog'
import { openReview } from './ReviewDialog'
import { t } from '../i18n'
import { openKeysoundImport } from './KeysoundImportDialog'

interface Item {
  label: string
  hint?: string
  onClick: () => void
}

function Menu({ label, items }: { label: string; items: (Item | 'sep')[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [open])
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)}>{label}</button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 24,
            left: 0,
            minWidth: 210,
            background: 'var(--bg-alt)',
            border: '1px solid var(--border-strong)',
            borderRadius: 4,
            boxShadow: 'var(--shadow)',
            padding: '4px',
            zIndex: 100,
          }}
        >
          {items.map((it, i) =>
            it === 'sep' ? (
              <div key={i} style={{ height: 1, background: 'var(--border)', margin: '4px 2px' }} />
            ) : (
              <button
                key={i}
                style={{
                  display: 'flex',
                  width: '100%',
                  padding: '5px 10px',
                  borderRadius: 3,
                  justifyContent: 'space-between',
                  gap: 16,
                  fontSize: 12.5,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                onClick={() => {
                  setOpen(false)
                  it.onClick()
                }}
              >
                <span>{it.label}</span>
                {it.hint && <span style={{ color: 'var(--text-faint)' }}>{it.hint}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  )
}

export default function TitleBar() {
  const files = useStore((s) => s.files)
  const activeId = useStore((s) => s.activeId)
  const active = files.find((f) => f.id === activeId)
  const typeSound = useStore((s) => s.typeSound)
  const themePref = useStore((s) => s.theme)
  const [, setAudioTick] = useState(0)
  useEffect(() => engine.subscribe(() => setAudioTick((t) => t + 1)), [])


  const items = {
    file: [
      { label: t('新建音效谱'), hint: 'Ctrl+N', onClick: () => newChart() },
      { label: t('打开歌曲文件夹…'), hint: 'Ctrl+O', onClick: () => void openChartFolder() },      { label: t('打开 .hs 文件…'), hint: 'Ctrl+I', onClick: () => void openFiles() },
      { label: t('从 .osu 导入（原谱只读）'), onClick: () => void importOsu() },
      { label: t('从 .osu 导入音效…'), hint: 'Ctrl+Shift+I', onClick: () => void importOsuSounds() },
      { label: t('导入 MIDI / musictxt 到 [Keysound]…'), onClick: () => openKeysoundImport() },
      { label: t('打开示例谱面'), onClick: () => openDemo() },
      'sep' as const,
      {
        label: t('保存'),
        hint: 'Ctrl+S',
        onClick: () => void saveActive(false),
      },
      {
        label: t('另存为…'),
        hint: 'Ctrl+Shift+S',
        onClick: () => void saveActive(true),
      },
      'sep' as const,
      { label: t('打开谱面文件夹'), onClick: () => void openChartDir() },
      { label: t('将所有音效复制到谱面文件夹内（改名为代号）'), onClick: () => void bundleSoundsToChartDir() },
      'sep' as const,
      { label: t('导出音效包（写入 [Files] path）'), onClick: () => void exportOsuPackage() },
      { label: t('把音效写入 .osu…（替代 Hitsound Copier）'), onClick: () => void writeOsuHitsounds() },
      { label: t('另存为 .osu…（不复制音效）'), onClick: () => void exportOsu() },
      { label: t('导出时间轴 CSV'), onClick: () => void exportCsv() },
      { label: t('导出音效映射 JSON'), onClick: () => void exportJson() },
      { label: t('导出音效映射 TXT'), onClick: () => void exportTxt() },
    ] as (Item | 'sep')[],
    view: [
      { label: t('资源管理器'), hint: 'Ctrl+B', onClick: () => useStore.getState().setSidebar('explorer') },
      { label: t('音频与试听'), onClick: () => useStore.getState().setSidebar('audio') },
      { label: t('设定'), onClick: () => useStore.getState().setSidebar('settings') },
      'sep' as const,
      { label: t('问题面板'), onClick: () => useStore.getState().setPanel('problems') },
      { label: t('时间轴'), onClick: () => useStore.getState().setPanel('timeline') },
      { label: t('文本编辑'), onClick: () => useStore.getState().setEditorMode('text') },
      { label: t('格子编辑'), onClick: () => useStore.getState().setEditorMode('grid') },
      { label: t('音效库'), onClick: () => useStore.getState().setPanel('samples') },
      { label: t('输出'), onClick: () => useStore.getState().setPanel('output') },
      'sep' as const,
      {
        label: `${themePref === 'light' ? '✓ ' : ''}${t('浅色主题')}`,
        onClick: () => useStore.getState().setTheme('light'),
      },
      {
        label: `${themePref === 'dark' ? '✓ ' : ''}${t('深色主题')}`,
        onClick: () => useStore.getState().setTheme('dark'),
      },
      {
        label: `${themePref === 'auto' ? '✓ ' : ''}${t('跟随系统')}`,
        onClick: () => useStore.getState().setTheme('auto'),
      },
      'sep' as const,
      { label: t('设置…'), hint: 'Ctrl+,', onClick: () => openAppSettings() },
    ] as (Item | 'sep')[],
    play: [
      { label: t('播放 / 暂停'), hint: 'Space', onClick: () => engine.toggle() },
      { label: t('回到开头'), onClick: () => engine.seek(0) },
      {
        label: `${engine.metronome ? '✓ ' : ''}${t('节拍器')}`,
        hint: engine.metronome ? t('已开启') : t('已关闭'),
        onClick: () => engine.setMetronome(!engine.metronome),
      },
      {
        label: `${typeSound ? '✓ ' : ''}${t('输入字符后播放音效')}`,
        hint: typeSound ? t('已开启') : t('已关闭'),
        onClick: () => useStore.getState().setTypeSound(!typeSound),
      },
      'sep' as const,
      { label: t('重新解析谱面'), hint: 'F5', onClick: () => useStore.getState().reparse() },
    ] as (Item | 'sep')[],
    review: [
      { label: t('音效使用次数统计'), onClick: () => openReview('usage') },
      { label: t('槽位冲突检测'), onClick: () => openReview('conflict') },
      { label: t('重复槽位音效检测'), onClick: () => openReview('dup') },
    ] as (Item | 'sep')[],
  }

  return (
    <div className="titlebar">
      <div className="brand">
        <IconLogo />
        osu Hitsound Studio
      </div>
      <div className="spacer" />
      {/* 菜单只在浏览器里兜底显示：Electron 下由原生菜单栏
          （文件/编辑/视图/播放/帮助）负责，避免和窗口顶部菜单重复 */}
      {!isDesktop() && (
        <div className="menu">
          <Menu label={t('文件')} items={items.file} />
          <Menu label={t('视图')} items={items.view} />
          <Menu label={t('播放')} items={items.play} />
          <Menu label={t('审阅')} items={items.review} />
        </div>
      )}
      <button
        className="tb-btn"
        title={active?.path || t('未关联磁盘文件')}
        onClick={() => void saveActive(false)}
      >
        {t('保存')}
      </button>
      <button
        className="tb-btn primary"
        title={t('导出 .osu 与音效文件（按 osu 标准命名）')}
        onClick={() => void exportOsuPackage()}
      >
        {t('导出音效包')}
      </button>
    </div>
  )
}
