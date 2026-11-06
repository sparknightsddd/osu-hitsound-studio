/**
 * 时间显示统一走 osu 的格式：`mm:ss:xxx`。
 *
 * 和 osu 编辑器里看到的一致：分钟不足两位补 0，秒与毫秒之间用冒号（不是小数点），
 * 毫秒补三位。例：8.625 秒 → `00:08:625`，2 分 3 秒 456 → `02:03:456`。
 *
 * 解析那边（MarkerText）本来就同时接受 `2:03.456` 和 `02:03:456`，所以显示改掉
 * 不影响已有谱面里的 `#2:03.456` 写法。
 */

/** 毫秒 → `mm:ss:xxx`（负数/非法值按 0 处理，毫秒向下取整） */
export function fmtOsuTime(ms: number): string {
  let t = Number.isFinite(ms) ? Math.floor(ms) : 0
  if (t < 0) t = 0
  const m = Math.floor(t / 60000)
  const s = Math.floor((t % 60000) / 1000)
  const f = t % 1000
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(3, '0')}`
}

/**
 * osu! 编辑器的「跳到某个时间点」链接：`osu://edit/mm:ss:xxx`。
 *
 * 由 osu! 自己注册的 osu:// 协议处理，格子视图右键「在 osu! Editor 中打开」用它。
 * 例：174202ms → `osu://edit/02:54:202`。
 */
export function osuEditUrl(ms: number): string {
  return `osu://edit/${fmtOsuTime(ms)}`
}
