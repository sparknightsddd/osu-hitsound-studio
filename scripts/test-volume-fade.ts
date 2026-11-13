/**
 * 渐变音量采样点：线性插值 + 首尾必写 + 间隔。
 */
import { fadeVolumePoints } from '../src/core/volumeFade'

let bad = 0
function ok(cond: boolean, name: string, extra = '') {
  if (!cond) {
    bad++
    console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`)
  } else console.log(`ok   ${name}${extra ? ' — ' + extra : ''}`)
}

// 1) 16 格，100 → 0，每 4 格一次：0/4/8/12/15，末段不足 4 格也照样补上终点
{
  const p = fadeVolumePoints(16, 100, 0, 4)
  ok(
    JSON.stringify(p) === JSON.stringify([
      { at: 0, volume: 100 },
      { at: 4, volume: 73 },
      { at: 8, volume: 47 },
      { at: 12, volume: 20 },
      { at: 15, volume: 0 },
    ]),
    '16 格 / 每 4 格 / 100→0',
    JSON.stringify(p),
  )
}

// 2) 每格都写
{
  const p = fadeVolumePoints(16, 100, 0, 1)
  ok(p.length === 16 && p[0].at === 0 && p[15].at === 15, '每格都写', String(p.length))
  ok(p[0].volume === 100 && p[15].volume === 0, '首尾音量正确', `${p[0].volume} .. ${p[15].volume}`)
  ok(
    p.every((x, i) => i === 0 || x.volume <= p[i - 1].volume),
    '音量单调不增',
  )
}

// 3) 间隔比整段还大 → 只留首尾
{
  const p = fadeVolumePoints(10, 80, 20, 99)
  ok(JSON.stringify(p) === JSON.stringify([{ at: 0, volume: 80 }, { at: 9, volume: 20 }]), '间隔过大只留首尾', JSON.stringify(p))
}

// 4) 起止相同
{
  const p = fadeVolumePoints(8, 60, 60, 2)
  ok(p.every((x) => x.volume === 60), '起止相同全是 60', JSON.stringify(p))
}

// 5) 边界：1 格 / 0 格 / step 0
{
  ok(JSON.stringify(fadeVolumePoints(1, 100, 30, 4)) === JSON.stringify([{ at: 0, volume: 30 }]), '1 格取结束音量')
  ok(fadeVolumePoints(0, 100, 0, 1).length === 0, '0 格为空')
  const p = fadeVolumePoints(5, 100, 0, 0)
  ok(p.length === 5 && p[4].at === 4, 'step 0 当 1 处理', JSON.stringify(p.map((x) => x.at)))
}

// 6) 音量夹在 0–100
{
  const p = fadeVolumePoints(4, 150, -50, 1)
  ok(p[0].volume === 100 && p[3].volume === 0, '越界音量被夹住', JSON.stringify(p))
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
process.exitCode = bad ? 1 : 0
