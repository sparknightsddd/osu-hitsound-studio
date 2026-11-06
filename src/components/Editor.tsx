import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { basicSetup } from 'codemirror'
import { lintGutter, setDiagnostics } from '@codemirror/lint'
import { indentWithTab, redo, redoDepth, selectAll, undo, undoDepth } from '@codemirror/commands'
import { musictxtLanguage } from '../editor/lang'
import { openEditMenu } from './EditMenu'
import { readClipboard, writeClipboard } from '../core/clipboard'
import { t } from '../i18n'
import type { Diagnostic } from '../core/types'

interface Props {
  fileId: string
  content: string
  theme: 'light' | 'dark'
  diagnostics: Diagnostic[]
  definedNames: Set<string>
  onChange: (v: string) => void
  onCursor: (line: number, col: number, sel: number) => void
  onView: (v: EditorView | null) => void
  onNameTyped: (name: string) => void
}

function sectionAt(text: string, pos: number): string {
  const before = text.slice(0, pos)
  let last = ''
  const re = /^\s*\[([A-Za-z]+)\]\s*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(before))) last = m[1].toLowerCase()
  return last
}

export default function Editor(props: Props) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const cb = useRef(props)
  cb.current = props
  const lastTyped = useRef('')
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (!host.current) return
    const view = new EditorView({
      parent: host.current,
      state: EditorStateInit(props),
    })
    viewRef.current = view
    props.onView(view)
    return () => {
      props.onView(null)
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fileId, props.theme])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (view.state.doc.toString() !== props.content) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: props.content },
      })
    }
  }, [props.content])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch(
      setDiagnostics(
        view.state,
        props.diagnostics.map((d) => ({
          from: Math.min(d.from, view.state.doc.length),
          to: Math.min(d.to, view.state.doc.length),
          severity: d.severity,
          message: d.message,
        })),
      ),
    )
  }, [props.diagnostics])

  function EditorStateInit(p: Props) {
    return EditorState.create({
      doc: p.content,
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        musictxtLanguage(p.theme),
        lintGutter(),
        EditorView.lineWrapping,
        EditorView.theme(
          {
            '&': {
              backgroundColor: 'var(--bg)',
              color: 'var(--text)',
              height: '100%',
              fontSize: '13.5px',
            },
            '.cm-scroller': { overflow: 'auto' },
            '.cm-content': { caretColor: 'var(--accent)', paddingBottom: '40vh' },
            '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
            '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
              backgroundColor: 'var(--sel)',
            },
            '.cm-activeLine': { backgroundColor: 'transparent' },
            '.cm-gutters': {
              backgroundColor: 'var(--bg)',
              color: 'var(--gutter)',
              border: 'none',
              paddingRight: '4px',
            },
            '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
            '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 14px', minWidth: '38px' },
            '.cm-foldGutter .cm-gutterElement': { opacity: 0.5 },
            '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
              backgroundColor: 'var(--accent-soft)',
              outline: 'none',
            },
            '.cm-tooltip': {
              border: '1px solid var(--border-strong)',
              backgroundColor: 'var(--bg-alt)',
              color: 'var(--text)',
            },
            '.cm-lint-marker': { width: '1em', height: '1em' },
            '.cm-panels': { backgroundColor: 'var(--bg-alt)', color: 'var(--text)' },
          },
          { dark: p.theme === 'dark' },
        ),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            cb.current.onChange(u.state.doc.toString())
            scheduleTypeSound(u.view)
          }
          if (u.selectionSet || u.docChanged) {
            const head = u.state.selection.main.head
            const line = u.state.doc.lineAt(head)
            cb.current.onCursor(line.number, head - line.from + 1, u.state.selection.main.to - u.state.selection.main.from)
          }
        }),
      ],
    })
  }

  function scheduleTypeSound(view: EditorView) {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const p = cb.current
      const head = view.state.selection.main.head
      const text = view.state.doc.toString()
      if (sectionAt(text, head) !== 'hitsound') return
      const line = view.state.doc.lineAt(head)
      const before = line.text.slice(0, head - line.from)
      const m = /([A-Z][a-z]*)$/.exec(before)
      if (!m) return
      const name = m[1]
      if (name === lastTyped.current) return
      lastTyped.current = name
      if (p.definedNames.has(name)) p.onNameTyped(name)
    }, 130)
  }

  /** 右键菜单：撤销/剪切/复制/粘贴/全选（CodeMirror 自己的历史与选区） */
  const openMenu = (e: ReactMouseEvent) => {
    e.preventDefault()
    const v = viewRef.current
    if (!v) return
    // 右键点在选区外 → 先把光标挪过去（和大多数编辑器一致）
    const pos = v.posAtCoords({ x: e.clientX, y: e.clientY })
    if (pos != null) {
      const s = v.state.selection.main
      if (pos < s.from || pos > s.to) v.dispatch({ selection: { anchor: pos } })
    }
    const sel = v.state.selection.main
    const hasSel = sel.from !== sel.to
    openEditMenu(e.clientX, e.clientY, [
      {
        label: t('撤销'),
        hint: 'Ctrl+Z',
        disabled: undoDepth(v.state) === 0,
        onClick: () => {
          undo(v)
          v.focus()
        },
      },
      {
        label: t('重做'),
        hint: 'Ctrl+Shift+Z',
        disabled: redoDepth(v.state) === 0,
        onClick: () => {
          redo(v)
          v.focus()
        },
      },
      {
        label: t('剪切'),
        hint: 'Ctrl+X',
        disabled: !hasSel,
        sep: true,
        onClick: () => {
          const s2 = v.state.selection.main
          if (s2.from === s2.to) return
          void writeClipboard(v.state.sliceDoc(s2.from, s2.to))
          v.dispatch({
            changes: { from: s2.from, to: s2.to, insert: '' },
            selection: { anchor: s2.from },
          })
          v.focus()
        },
      },
      {
        label: t('复制'),
        hint: 'Ctrl+C',
        disabled: !hasSel,
        onClick: () => {
          const s2 = v.state.selection.main
          if (s2.from === s2.to) return
          void writeClipboard(v.state.sliceDoc(s2.from, s2.to))
          v.focus()
        },
      },
      {
        label: t('粘贴'),
        hint: 'Ctrl+V',
        onClick: () => {
          void (async () => {
            const text = await readClipboard()
            if (text) v.dispatch(v.state.replaceSelection(text))
            v.focus()
          })()
        },
      },
      {
        label: t('全选'),
        hint: 'Ctrl+A',
        sep: true,
        onClick: () => {
          selectAll(v)
          v.focus()
        },
      },
    ])
  }

  return <div className="editor-host" ref={host} onContextMenu={openMenu} />
}
