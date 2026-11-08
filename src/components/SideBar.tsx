import { useMemo, useRef, useState } from 'react'
import { useStore, type ThemePref } from '../store'
import { engine } from '../audio/engine'
import {
  IconAudio,
  IconClose,
  IconFolder,
  IconPencil,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconUpload,
  IconWave,
} from './Icons'
import { fromOsu } from '../core/exporter'
import { loadTimingPrefs } from '../core/importPrefs'
import { describeKeysoundFiles } from '../core/keysound'
import { midiToName } from '../core/pitch'
import { fmtOsuTime } from '../core/time'
import AutoLoad from './AutoLoad'
import VolumeControl from './VolumeControl'
import MapsetBrowser from './MapsetBrowser'
import SoundLibrary from './SoundLibrary'
import { isDesktop } from '../core/desktop'
import { closeChart, importOsuSounds, openChartFolder } from '../core/actions'
import { t } from '../i18n'

export default function SideBar() {
  const view = useStore((s) => s.sidebar)
  const names = {
    explorer: t('资源管理器'),
    mapsets: t('谱面库'),
    sounds: t('音效库'),
    audio: t('音频与试听'),
    settings: t('设定'),
  }[view]
  return (
    <>
      <div className="sidebar-title">
        <span>{names}</span>
        <div style={{ display: 'flex', gap: 2 }}>
          {view === 'explorer' && <ExplorerActions />}
          {view === 'audio' && (
            <button
              className="icon-btn"
              title={t('重新加载已绑定的音效')}
              onClick={() => {
                const b = useStore.getState().bindings
                engine.loadPersisted(Object.keys(b))
                useStore.getState().log(t('已重新载入本地音效文件'))
              }}
            >
              <IconRefresh className="sm" />
            </button>
          )}
        </div>
      </div>
      <div className="sidebar-body">
        {view === 'explorer' && <Explorer />}
        {view === 'mapsets' && <MapsetBrowser />}
        {view === 'sounds' && <SoundLibrary />}
        {view === 'audio' && <AudioPanel />}
        {view === 'settings' && <SettingsPanel />}
      </div>
    </>
  )
}

function ExplorerActions() {
  const newFile = useStore((s) => s.newFile)
  const addFile = useStore((s) => s.addFile)
  const setActive = useStore((s) => s.setActive)
  const log = useStore((s) => s.log)
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <button className="icon-btn" title={t('新建文件')} onClick={() => newFile()}>
        <IconPlus className="sm" />
      </button>
      <button className="icon-btn" title={t('打开歌曲文件夹（.hs 可编辑 / .osu 只读）')} onClick={() => void openChartFolder()}>
        <IconFolder className="sm" />
      </button>
      <button className="icon-btn" title={t('导入文件（.hs 可编辑 / .osu 只读导入）')} onClick={() => input.current?.click()}>
        <IconUpload className="sm" />
      </button>
      <button
        className="icon-btn"
        title={t('从 .osu 导入音效（解析 auto 采样组与滑条节点；不选文件则建空白音效谱）')}
        onClick={() => void importOsuSounds()}
      >
        <IconWave className="sm" />
      </button>
      <input
        ref={input}
        type="file"
        accept=".hs,.osu"
        multiple
        style={{ display: 'none' }}
        onChange={async (e) => {
          const files = [...(e.target.files || [])]
          for (const f of files) {
            const text = await f.text()
            if (/\.osu$/i.test(f.name)) {
              // .osu 只读：解析成独立的 .hs 文档，绝不关联原文件路径
              const { TEMPLATE } = await import('../samples/demo')
              const r = fromOsu(text, TEMPLATE, '', { inheritMs: loadTimingPrefs().inheritMs })
              const id = addFile(f.name.replace(/\.osu$/i, '') + '.hs', r.text)
              setActive(id)
              log(
                `已从 ${f.name} 只读导入为 .hs：${r.timingCount} 条红线${r.skippedGreen ? `，忽略 ${r.skippedGreen} 条绿线` : ''}（原 .osu 未关联，保存不会写回）`,
              )
            } else {
              const id = addFile(f.name, text)
              setActive(id)
              log(`已导入 ${f.name}`)
            }
          }
          e.target.value = ''
        }}
      />
    </>
  )
}

function Explorer() {
  const files = useStore((s) => s.files)
  const activeId = useStore((s) => s.activeId)
  const setActive = useStore((s) => s.setActive)
  const renameFile = useStore((s) => s.renameFile)
  const [editing, setEditing] = useState<string | null>(null)

  return (
    <>
      <div className="sidebar-title" style={{ paddingLeft: 16, height: 28 }}>
        <span style={{ textTransform: 'none', letterSpacing: 0 }}>
          {t('工作区 · {n} 个文件', { n: files.length })}
        </span>
      </div>
      {files.map((f) => (
        <div
          key={f.id}
          className={`file-item ${f.id === activeId ? 'on' : ''}`}
          onClick={() => setActive(f.id)}
          onDoubleClick={() => setEditing(f.id)}
        >
          <IconFolder className="sm" />
          {editing === f.id ? (
            <input
              autoFocus
              defaultValue={f.name}
              style={{ flex: 1, padding: '1px 4px' }}
              onBlur={(e) => {
                renameFile(f.id, e.target.value || f.name)
                setEditing(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setEditing(null)
              }}
            />
          ) : (
            <span className="nm">{f.name}</span>
          )}
          <div className="act">
            <button
              title={t('重命名')}
              onClick={(e) => {
                e.stopPropagation()
                setEditing(f.id)
              }}
            >
              <IconPencil className="sm" />
            </button>
            <button
              title={t('关闭')}
              onClick={(e) => {
                e.stopPropagation()
                void closeChart(f.id)
              }}
            >
              <IconClose className="sm" />
            </button>
          </div>
        </div>
      ))}
      <div className="section">
        <h4>{t('说明')}</h4>
        <div className="hint">
          {isDesktop()
            ? t('桌面版：Ctrl+S 直接写回磁盘文件，标签上的 ● 表示有未保存改动，关窗时会提醒。')
            : t('文件保存在浏览器本地，音效文件也保存在浏览器里。')}
          <br />
          {t('双击文件名可重命名。')}
        </div>
      </div>
    </>
  )
}


function fmtInfo(info: { duration: number; builtin: boolean } | null): string {
  if (!info) return ''
  const ms = Math.round(info.duration * 1000)
  const d = ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`
  return `${d}${info.builtin ? ' ' + t('内置') : ''}`
}

function AudioPanel() {
  const [, force] = useState(0)
  const log = useStore((s) => s.log)
  const doc = useStore((s) => s.doc)
  const input = useRef<HTMLInputElement>(null)
  const rerender = () => force((x) => x + 1)

  return (
    <>
      <AutoLoad />
      <div className="section">
        <h4>{t('歌曲')}</h4>
        <div className="row">
          <button className="btn" onClick={() => input.current?.click()}>
            {t('选择本地音频')}
          </button>
          <input
            ref={input}
            type="file"
            accept="audio/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f) return
              engine
                .loadSong(f)
                .then(() => {
                  log(t('已载入歌曲 {name}', { name: f.name }))
                  rerender()
                })
                .catch(() => log(t('音频载入失败')))
            }}
          />
        </div>
        <div className="row">
          <label>{t('当前')}</label>
          <div className="val hint">
            {engine.songName || t('未选择（将只用节拍器打点）')}
          </div>
          {engine.songName && (
            <button
              className="icon-btn"
              title={t('移除')}
              onClick={() => {
                engine.clearSong()
                rerender()
              }}
            >
              <IconTrash className="sm" />
            </button>
          )}
        </div>
        {engine.songError && (
          <div className="hint" style={{ color: 'var(--error, #e51400)' }}>
            ⚠ {engine.songError}
          </div>
        )}
        {!engine.songName && doc.audioPath && (
          <div className="hint">
            {t('谱面里写的音频：')}<span className="mono">{doc.audioPath}</span>
            <br />
            {t('浏览器读不到本地绝对路径，用上面的「按 [Files] 自动载入」选中目录即可。')}
          </div>
        )}
        {engine.songName && (
          <div className="row">
            <button
              className="btn small"
              onClick={() => {
                const el = engine.songEl
                if (!el) return
                if (el.paused) {
                  el.currentTime = 0
                  // 音乐现在走 WebAudio 总线，先唤醒音频图再播，否则会静音空转
                  engine.resume()
                  el.play().catch((e) => log(`试播失败：${e?.message || e}`))
                  log('正在试播歌曲，听不到请检查系统音量与浏览器站点音量')
                } else {
                  el.pause()
                }
              }}
            >
              <IconPlay className="sm" /> {t('单独试播歌曲')}
            </button>
          </div>
        )}
      </div>

      <div className="section">
        <h4>{t('播放')}</h4>
        <VolumeControl />
        <div className="row">
          <label>{t('节拍器')}</label>
          <input
            type="checkbox"
            defaultChecked={engine.metronome}
            onChange={(e) => engine.setMetronome(e.target.checked)}
          />
          <span className="hint">{t('按拍打点，方便对节奏')}</span>
        </div>
        <div className="hint">
          {t('空格键 = 播放/暂停，编辑器里输入已定义的音效名会自动试听。')}
        </div>
      </div>

      <div className="section">
        <h4>
          {t('快速试听')}
          <span className="hint">{doc.hitsounds.filter((h) => h.name).length} {t('个音效')}</span>
        </h4>
        {doc.hitsounds
          .filter((h) => h.name)
          .map((h) => (
            <div key={h.name} className="row" style={{ marginBottom: 4 }}>
              <button
                className="icon-btn"
                title={t('试听')}
                onClick={() => {
                  if (!engine.playSample(h.name!, 100))
                    log(
                      h.defaultRef
                        ? t('"{name}" 是默认音效 {ref}，但内置库里没有对应文件', { name: h.name ?? '', ref: h.defaultRef })
                        : t('"{name}" 还没有绑定音频文件，去「音效库」选一个', { name: h.name ?? '' }),
                    )
                }}
              >
                <IconPlay className="sm" />
              </button>
              <span className="mono" style={{ color: 'var(--accent)', fontWeight: 700, minWidth: 34 }}>
                {h.name}
              </span>
              <span className="val hint">{h.resolvedPath || h.value}</span>
              {engine.hasSound(h.name!) ? (
                <span
                  className="hint"
                  title={t('已解码')}
                  style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}
                >
                  {fmtInfo(engine.sampleInfo(h.name!))}
                </span>
              ) : null}
              {engine.hasSound(h.name!) ? <span className="ok-dot" /> : <span className="no-dot" />}
            </div>
          ))}
        {doc.hitsounds.filter((h) => h.name).length === 0 && (
          <div className="hint">{t('还没有在 [Define] 里定义音效')}</div>
        )}
      </div>

      <div className="section">
        <h4>{t('关于音频')}</h4>
        <div className="hint">
          <IconAudio className="sm" /> {t('音效文件按「音效名」绑定，绑定后即使刷新页面也会保留。路径只作为导出时的参考，浏览器不会去读取它。')}
        </div>
      </div>
    </>
  )
}

function SettingsPanel() {
  const doc = useStore((s) => s.doc)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const s = doc.settings
  const rows: [string, string][] = [
    ['[Files] path', s.Path || (doc.baseDir ? t('（未设置，用 .hs 所在目录）') : t('（未设置）'))],
    [t('解析基准目录'), doc.baseDir || t('（未设置）')],
    ['[Files] audio', s.Audio || t('（未设置）')],
    ['[Files] ImportOsu', s.ImportOsu || t('（未设置）')],
    [t('音频完整路径'), doc.audioPath || t('（未设置）')],
    [t('导入谱面'), doc.importOsuPath || t('（未设置）')],
    ['Mode', s.Mode],
    ['Key', `{${s.Key.join(', ')}}`],
    ['AutoHitsoundIndex', String(s.AutoHitsoundIndex)],
    ['SliderSlide', String(s.SliderSlideHitsound)],
    ['SliderTick', String(s.SliderTickHitsound)],
    ['Spinner', String(s.SpinnerHitsound)],
    ['DefaultOverride', String(s.DefaultOverride)],
    ['StandardFormat', String(s.StandardFormat)],
    ['PreferredIndex', `{${s.PreferredIndex.join(', ')}}`],
    ['TimingAdsorb', `${s.TimingAdsorbRaw} = ${s.TimingAdsorb}`],
    [
      'Bookmarks',
      s.Bookmarks.length
        ? `${s.Bookmarks.length}：${s.Bookmarks.map(fmtOsuTime).join(' / ')}`
        : t('（未设置）'),
    ],
  ]
  const bpm = doc.timing.length ? 60000 / doc.timing[0].beatLength : 0
  return (
    <>
      <div className="section">
        <h4>{t('外观')}</h4>
        <div className="row">
          <label>{t('主题')}</label>
          <select value={theme} onChange={(e) => setTheme(e.target.value as ThemePref)}>
            <option value="light">{t('浅色（VSCode Light）')}</option>
            <option value="dark">{t('深色（VSCode Dark+）')}</option>
            <option value="auto">{t('跟随系统')}</option>
          </select>
        </div>
      </div>
      <div className="section">
        <h4>{t('[Settings] 解析结果')}</h4>
        {rows.map(([k, v]) => (
          <div key={k} className="row" style={{ marginBottom: 4 }}>
            <label style={{ width: 116 }}>{k}</label>
            <div className="val mono">{v}</div>
          </div>
        ))}
      </div>
      <div className="section">
        <h4>{t('[Keysound] 乐器')}</h4>
        {doc.hitsounds.filter((h) => h.kind === 'keysound' && h.name).length === 0 && (
          <div className="hint">{t('暂无（用 keysound 定义后，在 [Keysound] 首行花括号里引用）')}</div>
        )}
        {doc.hitsounds
          .filter((h) => h.kind === 'keysound' && h.name)
          .map((h) => (
            <div key={h.name} className="row" style={{ marginBottom: 4 }}>
              <label style={{ width: 92 }}>{h.name}</label>
              <div className="val mono hint">
                {h.soundFont
                  ? t('音色库') + ' ' + (h.path || h.value)
                  : h.keys
                    ? `${midiToName(h.keys.low)}~${midiToName(h.keys.high)} · ${h.keys.pattern}`
                    : h.value}
              </div>
            </div>
          ))}
      </div>
      <div className="section">
        <h4>{t('谱面统计')}</h4>
        <div className="hint">
          {t('Timing 点：{n} 个', { n: doc.timing.length })}
          {bpm ? t(' · 起始 {bpm} BPM', { bpm: bpm.toFixed(2) }) : ''}
          <br />
          {t('小节：{used}（网格已铺 {total}）', { used: doc.usedMeasures, total: doc.measures.length })}
          <br />
          {t('Keysound 音符：{k} · Hitsound 音符：{h}', { k: doc.events.filter((e) => e.kind === 'keysound').length, h: doc.events.filter((e) => e.kind !== 'keysound').length })}
          <br />
          {t('段落标记：{n}', { n: doc.markers.length })}
          {doc.markers.some((m) => m.time === null) ? t('（有 1 个以上解析失败）') : ''}
          <br />
          {t('音效定义：{a} · 乐句：{b} · 列表：{c}', { a: doc.hitsounds.length, b: doc.phrases.length, c: doc.lists.length })}
        </div>
      </div>
      <div className="section">
        <h4>{t('乐句')}</h4>
        {doc.phrases.map((p) => (
          <div key={p.name} className="row" style={{ marginBottom: 4 }}>
            <label style={{ width: 92 }}>@{p.name}</label>
            <div className="val mono hint">{p.body}</div>
          </div>
        ))}
        {doc.phrases.length === 0 && <div className="hint">{t('暂无')}</div>}
      </div>
    </>
  )
}
