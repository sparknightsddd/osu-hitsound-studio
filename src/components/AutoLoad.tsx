import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { t } from '../i18n'
import { engine } from '../audio/engine'
import {
  entriesFromFiles,
  matchHitsounds,
  matchKeysounds,
  matchSong,
  type PickedEntry,
} from '../core/fileMatch'
import { singleKeyName } from '../core/keysound'
import { isDesktop, materializeFile, pickAssetEntries } from '../core/desktop'

/**
 * 按 [Files] 里写的 path / audio / 音效相对路径，从用户选中的文件夹里自动配对。
 * 浏览器读不到任意本地路径，所以只能由用户选中目录后按相对路径匹配。
 * 匹配优先级：完整相对路径 > 路径后缀 > 纯文件名。
 */
export default function AutoLoad({ compact = false }: { compact?: boolean }) {
  const doc = useStore((s) => s.doc)
  const log = useStore((s) => s.log)
  const setBindings = useStore((s) => s.setBindings)
  const dirInput = useRef<HTMLInputElement>(null)
  const multiInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<string[]>([])

  const targets = useMemo(() => {
    const audioRaw = doc.settings.Audio || doc.settings.Song || ''
    const hs = doc.hitsounds.filter((h) => h.name && !h.defaultRef && h.value)
    return { audioRaw, hs, count: (audioRaw ? 1 : 0) + hs.length }
  }, [doc])

  async function run(entries: PickedEntry[]) {
    if (!entries.length) return
    setBusy(true)
    const lines: string[] = []
    const bindings = { ...useStore.getState().bindings }

    // 1) 歌曲
    const song = matchSong(doc, entries)
    if (song) {
      if (song.file) {
        await engine.loadSong(await materializeFile(song.file))
        lines.push(`歌曲 ✓ ${song.file.name}（${song.how} 匹配 "${song.relPath}"）`)
      } else {
        lines.push(`歌曲 ✗ 没找到 "${song.relPath}"`)
      }
    }

    // 2) 音效
    const ms = matchHitsounds(doc, entries)
    let ok = 0
    for (const m of ms) {
      if (!m.file) continue
      try {
        await engine.bindSample(m.target.name!, await materializeFile(m.file), false)
        bindings[m.target.name!] = {
          name: m.target.name!,
          fileName: m.file.name,
          size: m.file.size,
          auto: true,
        }
        ok++
      } catch {
        lines.push(`${m.target.name} ✗ 解码失败：${m.file.name}`)
      }
    }
    if (ok) lines.push(`音效 ✓ 自动绑定 ${ok}/${ms.length} 个`)
    else if (ms.length) lines.push(`音效 ✗ 0/${ms.length} 命中，检查 [Files] path 是否指向所选目录`)

    // 3) keysound：逐个音高的样本文件 + 音色库整体文件
    const { files: ksFiles, libs } = matchKeysounds(doc, entries)
    let kOk = 0
    for (const m of ksFiles) {
      if (!m.file) continue
      try {
        await engine.bindSample(m.keyName, await materializeFile(m.file), false)
        kOk++
      } catch {
        // 单个文件解码失败不打断其它音高
      }
    }
    if (ksFiles.length)
      lines.push(
        kOk
          ? `Keysound ✓ 自动绑定 ${kOk}/${ksFiles.length} 个音高样本`
          : `Keysound ✗ 0/${ksFiles.length} 个音高样本命中（检查路径模板，缺的音会改用内置合成音）`,
      )
    for (const l of libs) {
      if (!l.file) {
        lines.push(`乐器 ${l.instrument} ✗ 没找到 "${l.relPath}"`)
        continue
      }
      if (l.target.soundFont) {
        // .sf2/.sf3 需要专门的 SoundFont 合成器来解码，当前版本先用内置合成音发声
        lines.push(
          `乐器 ${l.instrument} ✓ 找到音色库 ${l.file.name}（.sf2/.sf3 尚未支持解码，暂用内置合成音试听）`,
        )
      } else {
        // 单一 wav 的 keysound：所有音高共用这一个样本，不做变调
        await engine.bindSample(singleKeyName(l.instrument), await materializeFile(l.file), false)
        lines.push(`乐器 ${l.instrument} ✓ ${l.file.name}（单一文件，所有音高共用，不变调）`)
      }
    }

    setBindings(bindings)
    setReport(lines)
    lines.forEach((l) => log(l))
    setBusy(false)
  }

  /** Electron：直接扫磁盘目录（不用一个个选文件） */
  async function fromFolder() {
    setBusy(true)
    try {
      const entries = await pickAssetEntries()
      if (!entries.length) {
        setBusy(false)
        return
      }
      await run(entries)
    } catch (err) {
      log(`✗ 读取文件夹失败：${String(err)}`)
      setBusy(false)
    }
  }

  // 暴露给原生菜单的「打开文件夹…」
  useEffect(() => {
    if (!isDesktop()) return
    ;(window as any).__autoLoadFolder = fromFolder
    return () => {
      if ((window as any).__autoLoadFolder === fromFolder) delete (window as any).__autoLoadFolder
    }
  })

  if (!targets.count) return null

  return (
    <div className="section">
      <h4>
        {t('按 [Files] 自动载入')}
        <span className="hint">{targets.count} {t('个目标路径')}</span>
      </h4>
      <div className="row">
        {isDesktop() ? (
          <button className="btn" disabled={busy} onClick={() => void fromFolder()}>
            {t('选择歌曲文件夹')}
          </button>
        ) : (
          <>
            <button className="btn" disabled={busy} onClick={() => dirInput.current?.click()}>
              {t('选择歌曲文件夹')}
            </button>
            <button className="btn" disabled={busy} onClick={() => multiInput.current?.click()}>
              {t('选择多个文件')}
            </button>
          </>
        )}
      </div>
      <input
        ref={dirInput}
        type="file"
        multiple
        style={{ display: 'none' }}
        {...({ webkitdirectory: '', directory: '' } as any)}
        onChange={(e) => {
          const fs = [...(e.target.files || [])]
          e.target.value = ''
          run(entriesFromFiles(fs))
        }}
      />
      <input
        ref={multiInput}
        type="file"
        multiple
        accept="audio/*,.wav,.ogg,.mp3"
        style={{ display: 'none' }}
        onChange={(e) => {
          const fs = [...(e.target.files || [])]
          e.target.value = ''
          run(entriesFromFiles(fs))
        }}
      />
      {!compact && (
        <div className="hint">
          {t('选中')} <span className="mono">{doc.settings.Path || t('谱面所在目录')}</span>{' '}
          {t('这一层，会按相对路径自动配对')}{' '}
          <span className="mono">{doc.settings.Audio || 'audio'}</span> {t('和各音效文件（原始文件不会上传，只在本页解码）。')}
        </div>
      )}
      {report.length > 0 && (
        <div className="hint" style={{ whiteSpace: 'pre-wrap' }}>
          {report.join('\n')}
        </div>
      )}
    </div>
  )
}
