/**
 * 「跳到某个时刻」的跨组件通知。
 *
 * 审阅报告里点时间时要做两件事：
 *   1. `engine.seek(t)` 把播放头挪过去；
 *   2. 让时间轴把这段滚进视野（时间轴的水平偏移是组件内部的 ref，外部拿不到）。
 *
 * 第 2 步用 window 上的一个事件传递：谁在看这个时刻谁自己响应，没有订阅者就静默。
 */
export const REVEAL_TIME_EVENT = 'hss:reveal-time'

/** 请求把某个时刻挪进时间轴视野（毫秒） */
export function revealTime(t: number) {
  if (!Number.isFinite(t)) return
  window.dispatchEvent(new CustomEvent(REVEAL_TIME_EVENT, { detail: t }))
}

/** 订阅「挪视野」请求，返回取消订阅函数 */
export function onRevealTime(fn: (t: number) => void): () => void {
  const handler = (e: Event) => {
    const t = Number((e as CustomEvent).detail)
    if (Number.isFinite(t)) fn(t)
  }
  window.addEventListener(REVEAL_TIME_EVENT, handler)
  return () => window.removeEventListener(REVEAL_TIME_EVENT, handler)
}
