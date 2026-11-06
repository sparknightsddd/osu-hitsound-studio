import { useRef, useState } from 'react'
import { selectResolvedTheme, useStore } from '../store'
import { engine } from '../audio/engine'
import { slotLabel } from '../core/exporter'
import Timeline from './Timeline'
import AutoLoad from './AutoLoad'
import { IconError, IconInfo, IconPause, IconPlay, IconTrash, IconUpload, IconWarn } from './Icons'
import type { Diagnostic } from '../core/types'
import { t } from '../i18n'

export default function BottomPanel() {
  const view = useStore((s) => s.panel)
  const doc = useStore((s) => s.doc)
  const errors = doc.diagnostics.filter((d) => d.severity === 'error').length
  const warns = doc.diagnostics.filter((d) => d.severity === 'warning').length
  return (
    <>
      <div className="panel-tabs">
        {(
          [
            ['problems', t('问题'), <IconError className="sm" key="e" />, errors],
            ['timeline', t('时间轴'), <IconInfo className="sm" key="t" />, null],
            ['samples', t('音效库'), <IconPlay className="sm" key="s" />, null],
            ['output', t('输出'), <IconInfo className="sm" key="o" />, null],
          ] as [typeof view, string, JSX.Element, number | null][]
        ).map(([id, label, icon, count]) => (
          <button key={id} className={view === id ? 'on' : ''} onClick={() => useStore.getState().setPanel(id)}>
            {icon}
            {label}
            {count ? <span className={`badge ${errors ? 'err' : 'warn'}`}>{count}</span> : null}
          </button>
        ))}
        <div className="spacer" />
        <button className="icon-btn" onClick={() => useStore.getState().togglePanel()} title={t('关闭面板')}>
          <IconTrash className="sm" />
        </button>
      </div>
      <div className="panel-body">
        {view === 'problems' && <Problems />}
        {view === 'timeline' && <TimelinePanel />}
        {view === 'samples' && <Samples />}
        {view === 'output' && <Output />}
      </div>
      {warns > 0 && errors === 0 && view === 'problems' && null}
    </>
  )
}

function TimelinePanel() {
  const doc = useStore((s) => s.doc)
  const theme = useStore(selectResolvedTheme)
  return (
    <div style={{ height: '100%', minHeight: 200 }}>
      <Timeline
        doc={doc}
        theme={theme}
        onPlaySample={(n, v, ev) => {
          // keysound 音符按音高发声（有真实样本用样本，没有就合成）
          if (ev && ev.kind === 'keysound' && typeof ev.pitch === 'number') {
            engine.playKey(ev.instrument, ev.pitch, v, ev.duration)
            return
          }
          engine.playSample(n, v)
        }}
      />
    </div>
  )
}

function Problems() {  const doc = useStore((s) => s.doc)
  const log = useStore((s) => s.log)
  const items = doc.diagnostics
  if (!items.length) return <div className="empty">{t('没有发现问题 ✓')}</div>
  return (
    <div>
      {items.map((d: Diagnostic, i) => (
        <div
          key={i}
          className={`prob ${d.severity}`}
          onClick={() => {
            const v = (window as any).__cmView
            if (v) {
              v.dispatch({ selection: { anchor: Math.min(d.from, v.state.doc.length) } })
              v.focus()
              log(t('已跳转到问题位置'))
            }
          }}
        >
          <span className="ico">
            {d.severity === 'error' ? (
              <IconError className="sm" />
            ) : d.severity === 'warning' ? (
              <IconWarn className="sm" />
            ) : (
              <IconInfo className="sm" />
            )}
          </span>
          <span style={{ flex: 1 }}>{d.message}</span>
          <span className="loc">{t('[行 {line}]', { line: lineOf(doc.text, d.from) })}</span>
          {d.code && <span className="loc">{d.code}</span>}
        </div>
      ))}
    </div>
  )
}

function lineOf(text: string, pos: number) {
  let n = 1
  for (let i = 0; i < pos && i < text.length; i++) if (text[i] === '\n') n++
  return n
}

function Samples() {
  const doc = useStore((s) => s.doc)
  const bindings = useStore((s) => s.bindings)
  const setBindings = useStore((s) => s.setBindings)
  const log = useStore((s) => s.log)
  const [, force] = useState(0)
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const list = doc.hitsounds.filter((h) => h.name)

  async function pick(name: string, file: File | undefined) {
    if (!file) return
    try {
      await engine.bindSample(name, file)
      setBindings({
        ...bindings,
        [name]: { name, fileName: file.name, size: file.size },
      })
      log(t('已绑定 "{name}" -> {file}', { name, file: file.name }))
      force((x) => x + 1)
    } catch {
      log(t('"{file}" 解码失败，请换一个 wav/ogg/mp3', { file: file.name }))
    }
  }

  return (
    <>
      {list.length === 0 && (
        <div className="empty">
          {t('[Define] 里还没有用')} <span className="mono">hitsound ... {t('名称')} = "{t('路径')}"</span> {t('定义音效')}
        </div>
      )}
      <div className="samples">
        {list.map((h) => {
          const b = bindings[h.name!]
          const has = engine.hasSound(h.name!)
          const isDefault = !!h.defaultRef && !b
          return (
            <div className="sample-card" key={h.name}>
              <div className="top">
                {has ? <span className="ok-dot" /> : <span className="no-dot" />}
                <span className="nm">{h.name}</span>
                <span className="slot">{slotLabel(h)}</span>
              </div>
              <div className="file" title={h.resolvedPath || h.value}>
                {b ? b.fileName : h.resolvedPath || h.value}
              </div>
              <div className="file hint">
                {isDefault
                  ? h.defaultRef === 'blank'
                    ? t('官方静音文件')
                    : t('官方默认音效（已内置，可直接试听）')
                  : h.defaultRef
                    ? t('已覆盖官方 {name}', { name: h.defaultRef })
                    : h.resolvedPath && h.resolvedPath !== h.value
                      ? `→ ${h.resolvedPath}`
                      : ''}
              </div>
              <div className="ops">
                <button className="btn small" onClick={() => inputRefs.current[h.name!]?.click()}>
                  <IconUpload className="sm" /> {b ? t('换文件') : t('选择文件')}
                </button>
                <button
                  className="btn small"
                  disabled={!has}
                  onClick={() => engine.playSample(h.name!, 100)}
                >
                  <IconPlay className="sm" /> {t('试听')}
                </button>
                {has && (
                  <button
                    className="btn small"
                    onClick={async () => {
                      await engine.clearSample(h.name!)
                      const nb = { ...bindings }
                      delete nb[h.name!]
                      setBindings(nb)
                    }}
                  >
                    <IconTrash className="sm" />
                  </button>
                )}
                <input
                  ref={(el) => (inputRefs.current[h.name!] = el)}
                  type="file"
                  accept="audio/*,.wav,.ogg,.mp3"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    e.target.value = ''
                    pick(h.name!, f)
                  }}
                />
              </div>
            </div>
          )
        })}
      </div>
      <AutoLoad compact />
      <div className="section">
        <div className="hint">
          {t('绑定后：① 时间轴播放时会用真实音效发声；② 在 [Hitsound] 正文里输入该音效名会自动试听；③ 手动选择的文件保存在本地，刷新后仍然有效；自动载入的不会，刷新后重选目录即可。')}
          <br />
          {t('写成')} <span className="mono">default.normal-hitnormal</span> {t('这类官方默认音效的，编辑器内置了 osu 官方 22 个 wav，无需绑定即可试听；自己选择文件可以覆盖它。')}
          <br />
          {t('相对路径会按 [Files] 的')} <span className="mono">path</span> {t('解析，导出时也会带解析后的完整路径。')}
        </div>
      </div>
    </>
  )
}

function Output() {
  const output = useStore((s) => s.output)
  const clearLog = useStore((s) => s.clearLog)
  return (
    <>
      <div className="panel-tabs" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="spacer" />
        <button className="btn small" onClick={clearLog}>
          {t('清空')}
        </button>
      </div>
      <div className="output">{output.length ? output.join('\n') : t('（暂无输出）')}</div>
    </>
  )
}
