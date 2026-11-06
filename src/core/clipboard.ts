/**
 * 系统剪贴板。Electron 下走 preload 暴露的同步接口（比 navigator.clipboard 稳，
 * 不受权限/焦点限制）；浏览器里退回 navigator.clipboard。
 */
import { desktopApi } from './desktop'

export async function writeClipboard(text: string): Promise<void> {
  const api = desktopApi()
  if (api?.clipboardWriteText) {
    try {
      await api.clipboardWriteText(text)
      return
    } catch {
      /* 落到 navigator */
    }
  }
  try {
    await navigator.clipboard?.writeText(text)
  } catch {
    /* 无剪贴板权限：静默失败，调用方只用来「顺手放一份」 */
  }
}

export async function readClipboard(): Promise<string> {
  const api = desktopApi()
  if (api?.clipboardReadText) {
    try {
      return String((await api.clipboardReadText()) ?? '')
    } catch {
      /* 落到 navigator */
    }
  }
  try {
    return (await navigator.clipboard?.readText()) ?? ''
  } catch {
    return ''
  }
}
