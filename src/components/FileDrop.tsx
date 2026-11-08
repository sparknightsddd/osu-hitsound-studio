/**
 * 拖文件进窗口：
 *   - `.hs` → 直接打开成新标签（关联磁盘路径，Ctrl+S 写回原文件）；
 *   - `.osu` → 和「从 .osu 导入音效」一样，读文件、选难度、抽出音效写成新谱；
 *     内容不是正经 .osu（比如 txt 改名）会当场拦下；
 *   - `.wav / .ogg` → 音效库的「+」：弹「添加到 [Define]」窗口，选槽位、填代号、写进谱面。
 *
 * 两个容易踩的点：
 *   - dragover 必须 preventDefault，否则 Chromium 会把文件当成导航目标，
 *     整个窗口直接跳去预览那个音频（应用就白屏了）；
 *   - Electron 32 起 File.path 没了，路径要问主进程（webUtils.getPathForFile）。
 */
import { useEffect, useRef, useState } from 'react'
import { addSoundFileDialog, importOsuFile, openDroppedCharts, verifyOsuText } from '../core/actions'
import { filePathOf } from '../core/desktop'
import { useStore } from '../store'
import { t } from '../i18n'

/** 音效只认这两类（和音效库列出来的一致） */
const SOUND_RE = /\.(wav|ogg)$/i
/** 拖 .hs 进来 = 直接打开这份谱面 */
const HS_RE = /\.hs$/i
/** 拖 .osu 进来 = 导入这份谱的音效 */
const OSU_RE = /\.osu$/i

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
      // 捕获阶段就截住：CodeMirror 会把拖入文件的内容直接插进正文
      e.stopPropagation()
      depth.current++
      setOver(true)
    }
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (!depth.current) setOver(false)
    }
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer) return
      const all = Array.from(e.dataTransfer.files)
      if (!all.length) return
      // 一律拦掉：拖进来的不是支持的文件也不能让窗口跳去 file://
      e.preventDefault()
      e.stopPropagation()
      reset()
      const hss = all.filter((f) => HS_RE.test(f.name))
      const osus = all.filter((f) => OSU_RE.test(f.name))
      const sounds = all.filter((f) => SOUND_RE.test(f.name))

      // .hs 优先：拖谱面进来就是想打开它（同时拖了 .osu / wav 也不抢）
      if (hss.length) {
        const rest = all.length - hss.length
        if (rest > 0) log(t('已忽略同时拖入的 {n} 个其它文件', { n: rest }))
        void openDroppedCharts(
          hss.map((f) => ({ name: f.name, file: f, path: filePathOf(f) || undefined })),
        )
        return
      }

      // .osu 其次：拖进来一般就是想导入这份谱的音效（同时拖了 wav 也不抢）
      if (osus.length) {
        const osu = osus[0]
        const p = filePathOf(osu)
        if (!p) {
          log(t('✗ 拿不到这个文件的磁盘路径（浏览器里请用「从 .osu 导入音效」）'))
          return
        }
        if (osus.length > 1) log(t('一次只导入一个 .osu，已选 {name}', { name: osu.name }))
        if (sounds.length) log(t('已忽略同时拖入的 {n} 个音效文件', { n: sounds.length }))
        void (async () => {
          // 先看内容：txt 改名的 .osu 在这里就被挡掉，不会进难度选择器
          if (!(await verifyOsuText(await osu.text(), osu.name))) return
          await importOsuFile(p)
        })()
        return
      }

      if (!sounds.length) {
        log(
          t('✗ 只支持拖入 .hs / .osu 谱面或 .wav / .ogg 音效（这次是：{files}）', {
            files: all.map((f) => f.name).join('、'),
          }),
        )
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

    // capture = true：要抢在 CodeMirror / 其它控件之前处理文件拖放
    window.addEventListener('dragenter', onEnter, true)
    window.addEventListener('dragover', onOver, true)
    window.addEventListener('dragleave', onLeave, true)
    window.addEventListener('drop', onDrop, true)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('dragenter', onEnter, true)
      window.removeEventListener('dragover', onOver, true)
      window.removeEventListener('dragleave', onLeave, true)
      window.removeEventListener('drop', onDrop, true)
      window.removeEventListener('blur', reset)
    }
  }, [])

  if (!over) return null
  return (
    <div className="drop-hint">
      <div className="drop-card">
        <div className="drop-title">{t('松手打开 / 导入')}</div>
        <div className="drop-sub">{t('.hs → 打开谱面')}</div>
        <div className="drop-sub">{t('.osu → 导入音效')}</div>
        <div className="drop-sub">{t('.wav / .ogg → 添加到 [Define]')}</div>
      </div>
    </div>
  )
}
