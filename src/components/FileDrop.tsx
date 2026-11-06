/**
 * 把 .wav / .ogg 拖进窗口 = 音效库的「+」：
 * 弹出同一个「添加到 [Define]」窗口，选槽位、填代号、写进谱面。
 *
 * 两个容易踩的点：
 *   - dragover 必须 preventDefault，否则 Chromium 会把文件当成导航目标，
 *     整个窗口直接跳去预览那个音频（应用就白屏了）；
 *   - Electron 32 起 File.path 没了，路径要问主进程（webUtils.getPathForFile）。
 */
import { useEffect, useRef, useState } from 'react'
import { addSoundFileDialog } from '../core/actions'
import { filePathOf } from '../core/desktop'
import { useStore } from '../store'
import { t } from '../i18n'

/** 只认这两类（和音效库列出来的一致） */
const SOUND_RE = /\.(wav|ogg)$/i

export default function FileDrop() {
  const [over, setOver] = useState(false)
  /** dragenter/dragleave 会随着子元素不停触发，用计数判断是不是真的离开了窗口 */
  const depth = useRef(0)

  useEffect(() => {
    const log = useStore.getState().log
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
    const reset = () => {
      depth.current = 0
      setOver(false)
    }

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current++
      setOver(true)
    }
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (!depth.current) setOver(false)
    }
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer) return
      // 一律拦掉：拖进来的不是音效也不能让窗口跳去 file://
      e.preventDefault()
      reset()
      const all = Array.from(e.dataTransfer.files)
      if (!all.length) return
      const sounds = all.filter((f) => SOUND_RE.test(f.name))
      if (!sounds.length) {
        log(t('✗ 只支持拖入 .wav / .ogg 音效文件（这次是：{files}）', { files: all.map((f) => f.name).join('、') }))
        return
      }
      const file = sounds[0]
      // 已经有一个「添加到 [Define]」开着：再拖会把它顶掉（前一个 promise 永远不 resolve）
      if (document.querySelector('.as-dialog')) {
        log(t('先把「添加到 [Define]」窗口处理完，再拖下一个音效'))
        return
      }
      const p = filePathOf(file)
      if (!p) {
        log(t('✗ 拿不到这个文件的磁盘路径（浏览器里请用音效库的 + 按钮）'))
        return
      }
      if (sounds.length > 1) log(t('一次只加一个音效，已选 {name}', { name: file.name }))
      void addSoundFileDialog({ name: file.name, path: p })
    }

    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('blur', reset)
    }
  }, [])

  if (!over) return null
  return (
    <div className="drop-hint">
      <div className="drop-card">
        <div className="drop-title">{t('松手添加音效')}</div>
        <div className="drop-sub">{t('.wav / .ogg → 添加到 [Define]')}</div>
      </div>
    </div>
  )
}
