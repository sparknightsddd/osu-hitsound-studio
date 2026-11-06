/**
 * 查找替换纯逻辑：解析代号、精确/包含匹配、仅替换匹配项 / 完全替换 / 留空删除。
 */
import { matchCell, parseCodes, replaceCell } from '../src/core/findReplace'

let bad = 0
function ok(cond: boolean, name: string) {
  if (!cond) {
    bad++
    console.log(`FAIL ${name}`)
  } else console.log(`ok   ${name}`)
}

// 1) 输入解析
ok(parseCodes('[Aa Ab]').join(',') === 'Aa,Ab', `方括号：${parseCodes('[Aa Ab]').join(',')}`)
ok(parseCodes('Aa, Ab').join(',') === 'Aa,Ab', `逗号：${parseCodes('Aa, Ab').join(',')}`)
ok(parseCodes('  Aa   Ab  ').join(',') === 'Aa,Ab', `空格：${parseCodes('  Aa   Ab  ').join(',')}`)
ok(parseCodes('Aa、Ab').join(',') === 'Aa,Ab', `顿号：${parseCodes('Aa、Ab').join(',')}`)
ok(parseCodes('Aa Aa').join(',') === 'Aa', '重复的只留一个')
ok(parseCodes('').length === 0 && parseCodes('[]').length === 0, '空输入')

// 2) 精确匹配
ok(matchCell(['Aa', 'Ab'], ['Aa', 'Ab'], true), '正好是 [Aa Ab]')
ok(matchCell(['Ab', 'Aa'], ['Aa', 'Ab'], true), '顺序无关')
ok(!matchCell(['Aa', 'Ab', 'Ac'], ['Aa', 'Ab'], true), '多一个 Ac 不算精确命中')
ok(!matchCell(['Aa'], ['Aa', 'Ab'], true), '少一个不算')
ok(!matchCell([], ['Aa'], true), '空格子不命中')

// 3) 包含匹配
ok(matchCell(['Aa', 'Ab', 'Ac'], ['Aa', 'Ab'], false), '[Aa Ab Ac] 含 Aa+Ab')
ok(matchCell(['Aa', 'Ab'], ['Aa', 'Ab'], false), '[Aa Ab] 本身也命中')
ok(!matchCell(['Aa', 'Ac'], ['Aa', 'Ab'], false), '缺 Ab 不命中')
ok(!matchCell(['Aa'], ['Aa', 'Ab'], false), '只有 Aa 不命中')

// 4) 仅替换匹配项
{
  const r = replaceCell(['Aa', 'Ac'], ['Aa'], ['Bb'], false, true)
  ok(r.join(',') === 'Bb,Ac', `[Aa Ac] → ${r.join(' ')}`)
}
{
  // 有 A 有 B：只把 A 删掉，不会出现两个 B
  const r = replaceCell(['Aa', 'Ab'], ['Aa'], ['Ab'], false, true)
  ok(r.join(',') === 'Ab', `[Aa Ab] 把 Aa 换成 Ab → ${r.join(' ')}`)
}
{
  const r = replaceCell(['Aa', 'Ab'], ['Aa', 'Ab'], ['Bc'], false, true)
  ok(r.join(',') === 'Bc', `[Aa Ab] 都命中 → ${r.join(' ')}`)
}
{
  const r = replaceCell(['Aa', 'Ac'], ['Aa'], ['Bb', 'Cc'], false, true)
  ok(r.join(',') === 'Bb,Cc,Ac', `新代号顶替原位置、Ac 保留 → ${r.join(' ')}`)
}
{
  const r = replaceCell(['Aa'], ['Aa'], [], false, true)
  ok(r.length === 0, '替换内容留空 = 删掉命中的代号')
}

// 5) 完全替换
{
  const r = replaceCell(['Aa', 'Ac', 'Ad'], ['Aa'], ['Bb'], false, false)
  ok(r.join(',') === 'Bb', `[Aa Ac Ad] → ${r.join(' ')}（Ac/Ad 不保留）`)
}
{
  const r = replaceCell(['Aa', 'Ac'], ['Aa'], [], false, false)
  ok(r.length === 0, '完全替换 + 留空 = 整格清空')
}
{
  const r = replaceCell(['Aa', 'Ab'], ['Aa', 'Ab'], ['Bb'], true, false)
  ok(r.join(',') === 'Bb', `精确匹配替换成 Bb：${r.join(' ')}`)
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
if (bad) process.exit(1)
