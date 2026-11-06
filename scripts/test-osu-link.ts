/**
 * `osu://edit/mm:ss:xxx` 链接格式（格子右键「在 osu! Editor 中打开」）。
 */
import { fmtOsuTime, osuEditUrl } from '../src/core/time'

let fail = 0
const T = (name: string, cond: boolean, extra = '') => {
  if (!cond) fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
}
const eq = (ms: number, want: string) => {
  const got = osuEditUrl(ms)
  T(`${ms}ms → ${want}`, got === want, got)
}

eq(174202, 'osu://edit/02:54:202')
eq(0, 'osu://edit/00:00:000')
eq(8289, 'osu://edit/00:08:289')
eq(107777.5, 'osu://edit/01:47:777') // 毫秒向下取整（和格子标题一致）
eq(3600000, 'osu://edit/60:00:000')
eq(-5, 'osu://edit/00:00:000')
T('fmtOsuTime 与链接里的时间一致', osuEditUrl(123456).endsWith(fmtOsuTime(123456)))

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS')
process.exit(fail ? 1 : 0)
