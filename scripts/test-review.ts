/**
 * 审阅三份报告的数据源：
 *   1) 使用次数（含没用到 / 没定义的代号）
 *   2) 槽位冲突（w/f/c 跨采样组、两个 hitnormal 不同组）
 *   3) 重复槽位音效（= 导出要混音的那些时刻）
 */
import { parseChart } from '../src/core/parse'
import { dupSlotReport, slotConflictReport, usageReport } from '../src/core/review'
import { fmtOsuTime } from '../src/core/time'

let fail = 0
const T = (name: string, cond: boolean, extra = '') => {
  if (!cond) fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
}

const head = (defs: string[], body: string[]) => `[Metadata]
Title = review

[Files]
path = "C:/fake"
audio = ""

[Define]
${defs.join('\n')}

[Timing]
0,bpm(120),4,0,0

[Hitsound]
${body.join('\n')}
`

// ---------------------------------------------------------------------------
// 1) 使用次数
// ---------------------------------------------------------------------------
{
  const doc = parseChart(
    head(
      ['hitsound soft-hitclap A = "a.wav"', 'hitsound soft-hitwhistle B = "b.wav"', 'hitsound drum-hitfinish C = "c.wav"'],
      ['#0', '/[A B] = = [B A]/', '#2000', '/B = = =/', '#4000', '/[A Xx] = = =/'],
    ),
  )
  const r = usageReport(doc)
  console.log(
    'ROWS',
    JSON.stringify(r.rows.map((x) => ({ code: x.code, n: x.count, first: x.first, last: x.last, def: x.defined }))),
  )
  const by = new Map(r.rows.map((x) => [x.code, x]))
  T('A 用了 3 次', by.get('A')?.count === 3, String(by.get('A')?.count))
  T('B 用了 3 次，从 0 到 2000', by.get('B')?.count === 3 && by.get('B')?.first === 0 && by.get('B')?.last === 2000,
    JSON.stringify(by.get('B')))
  T('C 定义了但没用到', by.get('C')?.count === 0 && by.get('C')?.defined === true, JSON.stringify(by.get('C')))
  T('Xx 用到但没定义', by.get('Xx')?.defined === false && by.get('Xx')?.count === 1, JSON.stringify(by.get('Xx')))
  T('未使用数量 = 1', r.unused === 1, String(r.unused))
  T('总次数 = 3 + 3 + 1', r.totalHits === 7, String(r.totalHits))
  T('次数降序、没用到排最后', r.rows[r.rows.length - 1].code === 'C', r.rows.map((x) => `${x.code}:${x.count}`).join(','))
  T('未定义代号单独列出', JSON.stringify(r.undefinedNames) === '["Xx"]', JSON.stringify(r.undefinedNames))
  T('时间格式化', fmtOsuTime(by.get('B')!.last!) === '00:02:000', fmtOsuTime(by.get('B')!.last!))
}

// 空谱面
{
  const r = usageReport(parseChart(head([], ['#0', '/= = = =/'])))
  T('没有定义时报告为空', r.rows.length === 0 && r.totalHits === 0, JSON.stringify(r))
}

// ---------------------------------------------------------------------------
// 2) 槽位冲突
// ---------------------------------------------------------------------------
{
  // w/f/c 跨采样组：A 只能 soft-hitclap，B 只能 drum-hitwhistle
  const doc = parseChart(
    head(['hitsound soft-hitclap A = "a.wav"', 'hitsound drum-hitwhistle B = "b.wav"'], ['#0', '/[A B] = = =/', '#2000', '/[A B] = = =/']),
  )
  const list = slotConflictReport(doc)
  console.log('CONFLICT', JSON.stringify(list))
  T('检出一个冲突组合', list.length === 1, String(list.length))
  T('冲突组合是 [A B]', list[0]?.names.join('+') === 'A+B', JSON.stringify(list[0]?.names))
  T('冲突带两处落点', JSON.stringify(list[0]?.times) === '[0,2000]', JSON.stringify(list[0]?.times))
  T('原因是 w/f/c 跨采样组', !!list[0]?.reason.includes('同属'), list[0]?.reason || '')
}

{
  // 两个 hitnormal 不同组
  const doc = parseChart(
    head(['hitsound soft-hitnormal C = "c.wav"', 'hitsound drum-hitnormal D = "d.wav"'], ['#0', '/[C D] = = =/']),
  )
  const list = slotConflictReport(doc)
  console.log('CONFLICT2', JSON.stringify(list))
  T('hitnormal 冲突也检出', list.length === 1, String(list.length))
  T('原因是 hitnormal 不能叠', !!list[0]?.reason.includes('hitnormal'), list[0]?.reason || '')
}

{
  // 同组 w/f/c 合法；没写 hitnormal 时白板兜底
  const doc = parseChart(
    head(['hitsound soft-hitclap A = "a.wav"', 'hitsound soft-hitwhistle B = "b.wav"'], ['#0', '/[A B] = = =/']),
  )
  T('同组叠音不报冲突', slotConflictReport(doc).length === 0, JSON.stringify(slotConflictReport(doc)))
}

{
  // 正文引用了不存在的代号
  const doc = parseChart(head(['hitsound soft-hitclap A = "a.wav"'], ['#0', '/[A Nope] = = =/']))
  const list = slotConflictReport(doc)
  T('未定义代号算冲突', list.length === 1 && list[0].reason.includes('Nope'), JSON.stringify(list))
}

// ---------------------------------------------------------------------------
// 3) 重复槽位音效
// ---------------------------------------------------------------------------
{
  const doc = parseChart(
    head(['hitsound soft-hitclap Z = "z.wav"', 'hitsound soft-hitclap L = "l.wav"'], [
      '#0',
      '/[Z L] = = =/',
      '#2000',
      '/Z = = =/',
      '#4000',
      '/[Z L] = = =/',
    ]),
  )
  const r = dupSlotReport(doc)
  console.log('DUP', JSON.stringify(r))
  T('没有导出错误', r.errors.length === 0, r.errors.join(' | '))
  T('一个槽位需要混音', r.rows.length === 1, String(r.rows.length))
  T('落点是 0 / 4000', JSON.stringify(r.rows[0]?.times) === '[0,4000]', JSON.stringify(r.rows[0]?.times))
  T('代号是 L+Z', r.rows[0]?.codes.slice().sort().join('+') === 'L+Z', JSON.stringify(r.rows[0]?.codes))
  T('文件名带槽位', r.rows[0]?.to.startsWith('soft-hitclap'), r.rows[0]?.to || '')
}

{
  const doc = parseChart(head(['hitsound soft-hitclap Z = "z.wav"'], ['#0', '/Z = = =/']))
  const r = dupSlotReport(doc)
  T('没有叠音时清单为空', r.rows.length === 0, JSON.stringify(r.rows))
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS')
process.exit(fail ? 1 : 0)
