/**
 * 「导入 MIDI / musictxt 到 [Keysound]」对话框。
 *
 * 做三件事：
 *   1. 读文件：`.mid/.midi` 走 MIDI 解析，`.hs/.txt` 当 musictxt 取它的 keysound 轨；
 *   2. 选目标：挑 [Define] 里已有的 keysound 乐器，或者当场新建一条定义；
 *   3. 给参数：量化、偏移、移调、力度、是否清空目标谱表。
 *
 * 真正的写回在 core/importKeysound.ts（复用格子的铺平/补行逻辑），
 * 这里只负责收集参数、预览数量和把结果塞回 store。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { t } from '../i18n'
import { desktopApi, pickFilesBrowser } from '../core/desktop'
import { describeMidi, parseMidi, type MidiFile } from '../core/midi'
import { dirname, parseChart } from '../core/parse'
import {
  ensureKeysoundStaff,
  importKeysoundNotes,
  readChartKeysound,
  transcribedDefine,
  upsertKeysoundDefine,
  type ChartKeysoundSource,
  type ImportNote,
} from '../core/importKeysound'
import { PIANO_HIGH, PIANO_LOW, midiToName } from '../core/pitch'
import { recordEdit } from '../core/gridHistory'

interface OpenRequest {
  file?: File
  path?: string
  id: number
}

let request: OpenRequest | null = null
let seq = 0
const subs = new Set<() => void>()

/** 打开对话框；可以带一个已经拿到的文件（拖放 .mid 进来时用） */
export function openKeysoundImport(opts: { file?: File; path?: string } = {}) {
  request = { ...opts, id: ++seq }
  subs.forEach((f) => f())
}

// 和 window.__store / __engine 一样，留给 CDP 自动化用
if (typeof window !== 'undefined') (window as any).__openKeysoundImport = openKeysoundImport

type Source =
  | { kind: 'midi'; name: string; path?: string; midi: MidiFile; selected: number[] }
  | { kind: 'chart'; name: string; path?: string; chart: ChartKeysoundSource; staff: number; withDefs: boolean }

/** 量化档位：每拍几格 + 给界面看的音符时值 */
const DIVS = [
  { div: 1, label: '1/4' },
  { div: 2, label: '1/8' },
  { div: 4, label: '1/16' },
  { div: 8, label: '1/32' },
  { div: 16, label: '1/64' },
]

const NEW = '@new'

function fmtMs(ms: number): string {
  const v = Math.max(0, ms)
  const m = Math.floor(v / 60000)
  const s = Math.floor((v % 60000) / 1000)
  const r = Math.round(v % 1000)
  return `${m}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`
}

/** 目录 + 默认的 12 音模板（A0 起，和语法文档里的例子一致） */
function defaultBlockFor(dirPath: string): string {
  const ext = /\.(ogg|mp3|flac)$/i.exec(dirPath)?.[1]?.toLowerCase() || 'wav'
  return `{lowest=A0,highest=C8,files="<loop("A","L","B","C","H","D","I","E","F","J","G","K")><int((i+9)/12)>.${ext}"}`
}

export default function KeysoundImportDialog() {
  const [, force] = useState(0)
  const box = useRef<HTMLDivElement>(null)

  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [source, setSource] = useState<Source | null>(null)

  /** 目标乐器：已有 keysound 的名字；NEW = 新建定义 */
  const [targetName, setTargetName] = useState('')
  /** 新建定义的三个字段 */
  const [newName, setNewName] = useState('piano')
  const [newPath, setNewPath] = useState('')
  const [newBlock, setNewBlock] = useState('')

  const [div, setDiv] = useState(4)
  const [offset, setOffset] = useState(0)
  const [transpose, setTranspose] = useState(0)
  const [outOfRange, setOutOfRange] = useState<'clamp' | 'skip'>('clamp')
  const [volumeMode, setVolumeMode] = useState<'fixed' | 'velocity'>('fixed')
  const [fixedVolume, setFixedVolume] = useState(100)
  const [replace, setReplace] = useState(false)

  useEffect(() => {
    const f = () => force((n) => n + 1)
    subs.add(f)
    return () => {
      subs.delete(f)
    }
  }, [])

  // 每次渲染后看一眼有没有新的打开请求（request 本身不触发渲染，靠上面的 force）
  useEffect(() => {
    if (!request) return
    const req = request
    request = null
    reset()
    setOpen(true)
    if (req.file) void loadFile(req.file, req.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })

  const doc = useStore((s) => s.doc)
  const keysoundDefs = useMemo(
    () => doc.hitsounds.filter((h) => h.kind === 'keysound' && !!h.name),
    [doc.hitsounds],
  )

  function reset() {
    setSource(null)
    setError('')
    setBusy(false)
    setDiv(4)
    setOffset(0)
    setTranspose(0)
    setOutOfRange('clamp')
    setVolumeMode('fixed')
    setFixedVolume(100)
    setReplace(false)
    setNewName('piano')
    setNewPath('')
    setNewBlock('')
    const first = useStore
      .getState()
      .doc.hitsounds.find((h) => h.kind === 'keysound' && h.name)
    setTargetName(first?.name || NEW)
  }

  async function loadFile(file: File, path?: string) {
    setError('')
    setBusy(true)
    try {
      const name = file.name || 'file'
      if (/\.(mid|midi|smf)$/i.test(name)) {
        const midi = parseMidi(await file.arrayBuffer())
        if (!midi.tracks.length) throw new Error(t('这个 MIDI 里没有音符'))
        // 默认选音符最多的那条轨：多数文件是旋律轨，全选会把伴奏/鼓一起铺进来
        let best = midi.tracks[0]
        for (const tr of midi.tracks) if (tr.notes.length > best.notes.length) best = tr
        setSource({ kind: 'midi', name, path, midi, selected: [best.index] })
      } else if (/\.(hs|txt)$/i.test(name)) {
        const chart = readChartKeysound(await file.text(), path ? dirname(path) : undefined)
        if (!chart.notes.length) throw new Error(t('这份谱面里没有 [Keysound] 音符'))
        // 目标里已有同名乐器时直接选它，省得再改
        const same = chart.staves.find((s) => keysoundDefs.some((d) => d.name === s.name))
        setSource({
          kind: 'chart',
          name,
          path,
          chart,
          staff: same?.staff ?? chart.staves[0]?.staff ?? 0,
          withDefs: true,
        })
        if (same) setTargetName(same.name)
        else if (chart.staves[0]?.name) setTargetName(chart.staves[0].name)
      } else {
        throw new Error(t('只支持 .mid / .midi 和 .hs / .txt'))
      }
    } catch (e) {
      setSource(null)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function pickFile() {
    const api = desktopApi()
    if (api) {
      const r = await api.openFiles({
        title: t('导入 MIDI / musictxt'),
        filters: [
          { name: t('MIDI / musictxt'), extensions: ['mid', 'midi', 'smf', 'hs', 'txt'] },
          { name: 'MIDI', extensions: ['mid', 'midi', 'smf'] },
          { name: 'musictxt', extensions: ['hs', 'txt'] },
        ],
      })
      if (r.canceled || !r.files?.length) return
      const f = r.files[0]
      const bin = await api.readBinary(f.path)
      if (!bin.ok || !bin.data) {
        setError(t('读取失败：{name}', { name: f.name }))
        return
      }
      const data = bin.data
      await loadFile(new File([data as BlobPart], f.name), f.path)
      return
    }
    const files = await pickFilesBrowser({ accept: '.mid,.midi,.smf,.hs,.txt', multiple: false })
    if (files[0]) await loadFile(files[0])
  }

  /** 选音色文件 / 目录：只填路径，内容等真正导入时由自动载入去读 */
  async function pickSoundPath(dir: boolean) {
    const api = desktopApi()
    if (!api) {
      setError(t('浏览器里请直接填写路径'))
      return
    }
    if (dir) {
      const r = await api.openFolder({ title: t('选择音色目录') })
      if (!r.canceled && r.dir) {
        const p = r.dir.replace(/\\/g, '/')
        setNewPath(`${p}/`)
        if (!newBlock.trim()) setNewBlock(defaultBlockFor(p))
      }
    } else {
      const r = await api.openFiles({
        title: t('选择音色文件'),
        filters: [
          { name: t('音色库 / 音频'), extensions: ['sf2', 'sf3', 'sfz', 'wav', 'ogg', 'mp3', 'flac'] },
        ],
      })
      if (!r.canceled && r.files?.length) {
        const p = r.files[0].path.replace(/\\/g, '/')
        setNewPath(p)
        setNewBlock('')
        if (!newName.trim() || newName === 'piano') {
          setNewName(p.split('/').pop()!.replace(/\.[a-z0-9]+$/i, '').replace(/[^\w-]/g, '') || 'piano')
        }
      }
    }
  }


  const targetInstrument = targetName === NEW ? newName.trim() : targetName

  /** 下拉选项：已有的 keysound 定义 + 来源里带来、目标还没有的那个名字 */
  const instrumentOptions = useMemo(() => {
    const names = keysoundDefs.map((d) => d.name!)
    if (targetName && targetName !== NEW && !names.includes(targetName)) names.push(targetName)
    return names
  }, [keysoundDefs, targetName])

  /** 来源音符（MIDI 取勾选的轨道，musictxt 取选中的谱表） */
  const sourceNotes = useMemo<ImportNote[]>(() => {
    if (!source) return []
    if (source.kind === 'midi') {
      const out: ImportNote[] = []
      for (const tr of source.midi.tracks) {
        if (!source.selected.includes(tr.index)) continue
        for (const n of tr.notes) out.push({ pitch: n.pitch, time: n.start, velocity: n.velocity, duration: n.end - n.start })
      }
      return out
    }
    return source.chart.notes.filter((n) => n.staff === source.staff)
  }, [source])

  /** 轻量预览：只算数量/时间范围，真正写回时才跑完整导入 */
  const preview = useMemo(() => {
    let min = Infinity
    let max = -Infinity
    let skipped = 0
    let low = 127
    let high = 0
    for (const n of sourceNotes) {
      const time = n.time + offset
      let pitch = Math.round(n.pitch) + transpose
      if (pitch < PIANO_LOW || pitch > PIANO_HIGH) {
        if (outOfRange === 'skip') {
          skipped++
          continue
        }
        while (pitch < PIANO_LOW) pitch += 12
        while (pitch > PIANO_HIGH) pitch -= 12
      }
      if (!Number.isFinite(time)) continue
      if (time < min) min = time
      if (time > max) max = time
      if (pitch < low) low = pitch
      if (pitch > high) high = pitch
    }
    const count = sourceNotes.length - skipped
    return { count, skipped, min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 0, low, high, empty: !Number.isFinite(min) }
  }, [sourceNotes, offset, transpose, outOfRange])

  const previewErrors = useMemo(() => {
    if (!source) return [] as string[]
    const out: string[] = []
    if (source.kind === 'chart' && source.chart.errorCount) {
      out.push(t('来源谱面有 {n} 处解析错误，能读到的音符仍会导入', { n: source.chart.errorCount }))
    }
    if (!targetInstrument) out.push(t('先选一个 keysound 乐器，或者新建一条定义'))
    if (targetName === NEW && !/^[^\s=|{}"']+$/.test(newName.trim())) {
      out.push(t('乐器名不能带空格和 = | { } " \''))
    }
    if (targetName !== NEW && targetInstrument && !keysoundDefs.some((d) => d.name === targetName)) {
      // 目标里没有这条定义：只有「从 musictxt 一并导入定义」才能补齐
      const willImport =
        source?.kind === 'chart' && source.withDefs && source.chart.defs.some((d) => d.name === targetName)
      if (!willImport) out.push(t('目标谱面里没有这个 keysound 定义'))
    }
    if (targetName === NEW && !newPath.trim()) out.push(t('新建定义要填路径'))
    if (preview.empty && sourceNotes.length) out.push(t('所有音符都在钢琴音域之外'))
    return out
  }, [source, targetInstrument, targetName, newName, newPath, preview.empty, sourceNotes.length, keysoundDefs])

  /** 不阻断导入、但要说一声的事（同名定义会被替换） */
  const previewWarnings = useMemo(() => {
    if (targetName === NEW && keysoundDefs.some((d) => d.name === newName.trim())) {
      return [t('已有同名定义，导入时会整条替换它')]
    }
    return []
  }, [targetName, newName, keysoundDefs])

  const doImport = async () => {
    if (!source || !preview.count || previewErrors.length) return
    setBusy(true)
    setError('')
    try {
      const st = useStore.getState()
      const active = st.files.find((f) => f.id === st.activeId)
      if (!active) throw new Error(t('没有打开的谱面'))
      const baseDir = active.path ? dirname(active.path) : undefined
      let text = active.content
      let cur = parseChart(text, { baseDir })

      // 1) 新建定义（或替换同名的旧定义）
      if (targetName === NEW) {
        const p = newPath.trim().replace(/\\/g, '/')
        const quoted = /^["']/.test(p) ? p : `"${p}"`
        const block = newBlock.trim()
        const defText = `keysound custom ${newName.trim()} = ${quoted}${block ? ` ${block}` : ''}`
        text = upsertKeysoundDefine(text, cur, defText, newName.trim())
        cur = parseChart(text, { baseDir })
      }

      // 2) 从 musictxt 一并搬定义：只搬「目标乐器」那条，目标里已经有同名定义就用目标那份
      if (source.kind === 'chart' && source.withDefs) {
        const srcDir = source.path ? dirname(source.path) : ''
        for (const def of source.chart.defs.filter((d) => d.name === targetInstrument)) {
          if (cur.hitsounds.some((h) => h.name === def.name)) continue
          const defText = transcribedDefine(source.chart.doc, def, srcDir)
          text = upsertKeysoundDefine(text, cur, defText, def.name!)
          cur = parseChart(text, { baseDir })
        }
      }

      // 3) 乐器不在 [Keysound] 首行里就补进去，拿到谱表下标
      const ens = ensureKeysoundStaff(text, cur, targetInstrument)
      text = ens.text
      cur = parseChart(text, { baseDir })

      // 4) 写音符
      const r = importKeysoundNotes(cur, sourceNotes, {
        staff: ens.staff,
        div,
        offsetMs: offset,
        transpose,
        outOfRange,
        volumeMode,
        fixedVolume,
        replace,
        instrument: targetInstrument,
        instruments: cur.keyInstruments.map((k) => k.name),
      })
      if (!r.ok || !r.text) {
        setError(r.reason || t('导入失败'))
        return
      }

      // 记进格子的撤销栈：导入后会自动切到格子视图，Ctrl+Z 能整步回退
      recordEdit(active.id, active.content, r.text)
      st.updateContent(active.id, r.text)
      st.reparse()
      st.setKsInst(`${ens.staff}:${targetInstrument}`)
      st.setEditorMode('grid')
      const s = r.stats
      st.log(
        `Keysound 导入：${source.name} → ${targetInstrument} · ${s.placed} 个音符 / ${s.cells} 格 / ${s.measures} 小节` +
          `${s.skipped ? ` · 跳过 ${s.skipped}` : ''}${s.quantizeMs >= 1 ? ` · 最大量化 ${Math.round(s.quantizeMs)}ms` : ''}`,
      )
      for (const w of r.warnings.slice(0, 4)) st.log('⚠ ' + w)
      setOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  const midiTracks = source?.kind === 'midi' ? source.midi.tracks : []
  const toggleTrack = (index: number) => {
    if (source?.kind !== 'midi') return
    const has = source.selected.includes(index)
    const selected = has ? source.selected.filter((x) => x !== index) : [...source.selected, index]
    setSource({ ...source, selected })
  }

  return (
    <div
      className="osu-diff-overlay"
      onMouseDown={() => !busy && setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) setOpen(false)
      }}
    >
      <div
        className="osu-diff ki-dialog"
        tabIndex={-1}
        ref={box}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="osu-diff-head">
          {t('导入 MIDI / musictxt 到 [Keysound]')}
          <span className="osu-diff-sub">
            {source ? `${source.name}${source.kind === 'midi' ? ` · ${describeMidi(source.midi)}` : ''}` : t('先选一个文件')}
          </span>
        </div>

        <div className="ki-body">
          {/* ---------- 来源 ---------- */}
          <div className="ki-sec">
            <div className="ki-sec-title">
              {t('来源')}
              <button className="btn small" onClick={() => void pickFile()}>
                {t('选择文件…')}
              </button>
            </div>
            {!source ? (
              <div className="hint">
                {t('支持 .mid / .midi（按轨道导入音符）和 .hs / .txt（取它的 [Keysound] 轨）。也可以直接把文件拖进窗口。')}
              </div>
            ) : source.kind === 'midi' ? (
              <>
                <div className="hint">
                  {t('勾选要导入的轨道；默认选音符最多的那条。')}
                  <button
                    className="ki-link"
                    onClick={() =>
                      setSource({ ...source, selected: midiTracks.map((x) => x.index) })
                    }
                  >
                    {t('全选')}
                  </button>
                  <button className="ki-link" onClick={() => setSource({ ...source, selected: [] })}>
                    {t('全不选')}
                  </button>
                </div>
                <div className="ki-tracks">
                  {midiTracks.map((tr) => {
                    const on = source.selected.includes(tr.index)
                    const low = tr.notes.reduce((n, x) => Math.min(n, x.pitch), 127)
                    const high = tr.notes.reduce((n, x) => Math.max(n, x.pitch), 0)
                    return (
                      <label key={tr.index} className={`ki-track${on ? ' on' : ''}`}>
                        <input type="checkbox" checked={on} onChange={() => toggleTrack(tr.index)} />
                        <span className="ki-track-name">{tr.name}</span>
                        <span className="ki-track-meta">
                          {tr.notes.length} {t('个音符')} · {midiToName(low)}~{midiToName(high)}
                          {tr.channels.length ? ` · ch ${tr.channels.map((c) => c + 1).join(',')}` : ''}
                          {tr.programs.length ? ` · program ${tr.programs.join(',')}` : ''}
                          {tr.percussion ? ` · ${t('打击乐')}` : ''}
                        </span>
                      </label>
                    )
                  })}
                </div>
              </>
            ) : (
              <>
                <div className="ki-staves">
                  {source.chart.staves.map((s) => (
                    <label key={`${s.staff}:${s.name}`} className={`ki-track${source.staff === s.staff ? ' on' : ''}`}>
                      <input
                        type="radio"
                        name="ki-staff"
                        checked={source.staff === s.staff}
                        onChange={() => {
                          setSource({ ...source, staff: s.staff })
                          setTargetName(s.name)
                        }}
                      />
                      <span className="ki-track-name">{s.name}</span>
                      <span className="ki-track-meta">
                        {s.count} {t('个音符')}
                        {s.count ? ` · ${midiToName(s.low)}~${midiToName(s.high)}` : ''}
                      </span>
                    </label>
                  ))}
                </div>
                {source.chart.defs.some((d) => d.name === targetInstrument) &&
                  !keysoundDefs.some((d) => d.name === targetInstrument) && (
                  <label className="ki-check">
                    <input
                      type="checkbox"
                      checked={source.withDefs}
                      onChange={(e) => setSource({ ...source, withDefs: e.target.checked })}
                    />
                    <span>
                      {t('一并导入这个乐器的 keysound 定义')}
                      <span className="hint">（{t('相对路径会改成来源目录的绝对路径')}）</span>
                    </span>
                  </label>
                )}
              </>
            )}
          </div>

          {/* ---------- 目标 ---------- */}
          <div className="ki-sec">
            <div className="ki-sec-title">{t('目标乐器')}</div>
            <div className="ki-row">
              <span className="ki-label">{t('乐器')}</span>
              <select className="set-input" value={targetName} onChange={(e) => setTargetName(e.target.value)}>
                {instrumentOptions.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
                <option value={NEW}>{t('＋ 新建 keysound 定义…')}</option>
              </select>
            </div>
            {targetName === NEW && (
              <>
                <div className="ki-row">
                  <span className="ki-label">{t('名称')}</span>
                  <input
                    className="set-input"
                    value={newName}
                    spellCheck={false}
                    onChange={(e) => setNewName(e.target.value.replace(/\s/g, ''))}
                    placeholder="piano"
                  />
                </div>
                <div className="ki-row">
                  <span className="ki-label">{t('路径')}</span>
                  <input
                    className="set-input mono"
                    value={newPath}
                    spellCheck={false}
                    onChange={(e) => setNewPath(e.target.value)}
                    placeholder={t('音色目录（以 / 结尾）或 .sf2/.sf3/.sfz/.wav')}
                  />
                  <button className="btn small" onClick={() => void pickSoundPath(false)}>
                    {t('文件…')}
                  </button>
                  <button className="btn small" onClick={() => void pickSoundPath(true)}>
                    {t('目录…')}
                  </button>
                </div>
                <div className="ki-row">
                  <span className="ki-label">{t('参数')}</span>
                  <input
                    className="set-input mono"
                    value={newBlock}
                    spellCheck={false}
                    onChange={(e) => setNewBlock(e.target.value)}
                    placeholder={`{lowest=A0,highest=C8,files="…"}`}
                  />
                </div>
                <div className="hint">
                  {t('参数块可以留空：.sf2/.sf3 不写就按 bank 0 / program 0；目录会自动补一条 12 音模板。')}
                </div>
              </>
            )}
          </div>

          {/* ---------- 选项 ---------- */}
          <div className="ki-sec">
            <div className="ki-sec-title">{t('导入选项')}</div>
            <div className="ki-grid">
              <label className="ki-field">
                <span>{t('量化')}</span>
                <select className="set-input" value={div} onChange={(e) => setDiv(Number(e.target.value))}>
                  {DIVS.map((d) => (
                    <option key={d.div} value={d.div}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="ki-field">
                <span>{t('偏移 (ms)')}</span>
                <input
                  className="set-input"
                  type="number"
                  step={1}
                  value={offset}
                  onChange={(e) => setOffset(Number(e.target.value) || 0)}
                />
              </label>
              <label className="ki-field">
                <span>{t('移调 (半音)')}</span>
                <input
                  className="set-input"
                  type="number"
                  step={1}
                  value={transpose}
                  onChange={(e) => setTranspose(Number(e.target.value) || 0)}
                />
              </label>
              <label className="ki-field">
                <span>{t('音域外')}</span>
                <select
                  className="set-input"
                  value={outOfRange}
                  onChange={(e) => setOutOfRange(e.target.value as 'clamp' | 'skip')}
                >
                  <option value="clamp">{t('拉回音域')}</option>
                  <option value="skip">{t('跳过')}</option>
                </select>
              </label>
              <label className="ki-field">
                <span>{t('音量')}</span>
                <select
                  className="set-input"
                  value={volumeMode}
                  onChange={(e) => setVolumeMode(e.target.value as 'fixed' | 'velocity')}
                >
                  <option value="fixed">{t('固定 {v}', { v: fixedVolume })}</option>
                  <option value="velocity">{t('按 MIDI 力度')}</option>
                </select>
              </label>
              <label className="ki-field">
                <span>{t('固定音量')}</span>
                <input
                  className="set-input"
                  type="number"
                  min={0}
                  max={100}
                  value={fixedVolume}
                  disabled={volumeMode !== 'fixed'}
                  onChange={(e) => setFixedVolume(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                />
              </label>
            </div>
            <label className="ki-check">
              <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
              <span>
                {t('导入前清空目标谱表')}
                <span className="hint">（{t('只清空这一个乐器，别的谱表和 [Hitsound] 不动')}）</span>
              </span>
            </label>
          </div>

          {/* ---------- 预览 ---------- */}
          <div className="ki-sec ki-preview">
            {source && !preview.empty ? (
              <>
                <b>{preview.count}</b> {t('个音符')}
                {preview.skipped ? <span className="hint"> · {t('跳过 {n}', { n: preview.skipped })}</span> : null}
                <span className="ki-preview-meta">
                  {fmtMs(preview.min)} ~ {fmtMs(preview.max)} · {midiToName(preview.low)}~{midiToName(preview.high)} ·{' '}
                  {t('量化')} {DIVS.find((d) => d.div === div)?.label} · {t('目标')} {targetInstrument || '—'}
                </span>
              </>
            ) : (
              <span className="hint">{source ? t('没有可导入的音符') : t('还没选文件')}</span>
            )}
            {previewErrors.length || previewWarnings.length ? (
              <div className="ki-warn">
                {previewErrors.map((e, i) => (
                  <div key={i}>⚠ {e}</div>
                ))}
                {previewWarnings.map((e, i) => (
                  <div key={`w${i}`} className="ki-note">
                    · {e}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="osu-diff-foot">
          <span className={`osu-diff-hint ${error ? 'si-err' : ''}`}>
            {error || t('音符会写进当前谱面的 [Keysound]，导入是一次撤销可回退的操作')}
          </span>
          <div className="si-actions">
            <button className="osu-diff-cancel" disabled={busy} onClick={() => setOpen(false)}>
              {t('取消')}
            </button>
            <button className="si-ok" disabled={busy || !source || !preview.count || previewErrors.length > 0} onClick={() => void doImport()}>
              {busy ? t('处理中…') : t('导入')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
