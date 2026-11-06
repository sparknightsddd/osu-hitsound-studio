/**
 * 格子编辑的撤销栈。
 *
 * 文本编辑器有自己的 undo（CodeMirror history），但它只认自己 dispatch 的改动；
 * 格子这边是通过 `updateContent` 整份替换的，所以单独记一份「操作前 / 操作后」。
 *
 * 安全策略：撤销前先检查栈顶的 `after` 是否等于当前文本。
 * 不等于说明这之后有人用别的方式改过（比如切回文本手打了几行），
 * 这时候直接清空历史并提示「没有可撤销的操作」，避免把手工改动一并撤掉。
 */
export interface HistoryEntry {
  fileId: string
  before: string
  after: string
}

const LIMIT = 200
const undoStack: HistoryEntry[] = []
const redoStack: HistoryEntry[] = []

export function recordEdit(fileId: string, before: string, after: string) {
  if (before === after) return
  undoStack.push({ fileId, before, after })
  if (undoStack.length > LIMIT) undoStack.shift()
  redoStack.length = 0
}

export function canUndo(fileId: string, current: string): boolean {
  const top = undoStack[undoStack.length - 1]
  return !!top && top.fileId === fileId && top.after === current
}

export function canRedo(fileId: string, current: string): boolean {
  const top = redoStack[redoStack.length - 1]
  return !!top && top.fileId === fileId && top.before === current
}

/** 返回撤销后的整份文本；没有可撤销的返回 null */
export function undoEdit(fileId: string, current: string): string | null {
  const top = undoStack[undoStack.length - 1]
  if (!top || top.fileId !== fileId) return null
  if (top.after !== current) {
    // 历史已经和当前文本脱节（中间有文本编辑），直接作废
    undoStack.length = 0
    redoStack.length = 0
    return null
  }
  undoStack.pop()
  redoStack.push(top)
  return top.before
}

/** 返回重做后的整份文本 */
export function redoEdit(fileId: string, current: string): string | null {
  const top = redoStack[redoStack.length - 1]
  if (!top || top.fileId !== fileId) return null
  if (top.before !== current) {
    redoStack.length = 0
    return null
  }
  redoStack.pop()
  undoStack.push(top)
  return top.after
}

/** 切文件/重新打开时清掉（目前只在测试里用） */
export function clearHistory() {
  undoStack.length = 0
  redoStack.length = 0
}
