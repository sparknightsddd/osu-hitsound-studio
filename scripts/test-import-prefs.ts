/** 验证「导入默认代号」的优先级 / = 白板 / 冲突回退逻辑。 */
import { planDefaultNames } from '../src/core/importPrefs'
import { soundCodeKey, type SoundCode } from '../src/core/osuSounds'

let bad = 0
const ok = (cond: boolean, msg: string) => {
  if (!cond) bad++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
}

function mk(set: 'soft' | 'normal' | 'drum', hit: string, index: number, file = ''): SoundCode {
  return {
    name: 'Zz',
    sampleSet: set,
    hitType: hit as SoundCode['hitType'],
    index,
    file,
    slot: `${set}-${hit}`,
    value: file ? `"${file}"` : `default.${set}-${hit}`,
  }
}

// 1) 同组合多个代码按顺序吃偏好
{
  const codes = [mk('normal', 'hitwhistle', 0), mk('normal', 'hitwhistle', 1), mk('normal', 'hitwhistle', 2), mk('normal', 'hitclap', 0)]
  const r = planDefaultNames(codes, { 'normal-hitwhistle': 'Ka, Kb, Kc', 'normal-hitclap': 'Ha' })
  ok(r.names[soundCodeKey(codes[0])] === 'Ka', '第 1 个 whistle -> Ka')
  ok(r.names[soundCodeKey(codes[1])] === 'Kb', '第 2 个 whistle -> Kb')
  ok(r.names[soundCodeKey(codes[2])] === 'Kc', '第 3 个 whistle -> Kc')
  ok(r.names[soundCodeKey(codes[3])] === 'Ha', 'clap -> Ha')
  ok(r.whiteboard === '', '没有 = 时没有白板')
}

// 2) = 表示白板
{
  const codes = [mk('normal', 'hitwhistle', 0), mk('normal', 'hitwhistle', 1), mk('normal', 'hitclap', 0)]
  const r = planDefaultNames(codes, { 'normal-hitwhistle': 'Ka, =', 'normal-hitclap': '=' })
  ok(r.names[soundCodeKey(codes[0])] === 'Ka', '第 1 个 whistle -> Ka')
  ok(r.whiteboard === soundCodeKey(codes[1]), 'whistle 第 2 个被设为白板')
  ok(r.names[soundCodeKey(codes[1])] === undefined, '白板没有代号')
  ok(r.names[soundCodeKey(codes[2])] === 'Aa', 'clap 的 = 因为白板已占用，退回自动名 Aa')
}

// 3) 不同组合填了同名 -> 后者回退自动名
{
  const codes = [mk('soft', 'hitnormal', 0), mk('drum', 'hitnormal', 0)]
  const r = planDefaultNames(codes, { 'soft-hitnormal': 'Ka', 'drum-hitnormal': 'Ka' })
  ok(r.names[soundCodeKey(codes[0])] === 'Ka', 'soft 拿到 Ka')
  ok(r.names[soundCodeKey(codes[1])] === 'Aa', 'drum 的 Ka 冲突，退回 Aa')
}

// 4) 空偏好 -> 全自动 Aa/Ab
{
  const codes = [mk('soft', 'hitfinish', 0), mk('soft', 'hitclap', 0)]
  const r = planDefaultNames(codes, {})
  ok(r.names[soundCodeKey(codes[0])] === 'Aa' && r.names[soundCodeKey(codes[1])] === 'Ab', '空偏好 -> Aa / Ab')
  ok(r.whiteboard === '', '空偏好 -> 没有白板')
}

// 5) 偏好里有非法字符也能用（设置界面会先规整，这里兜底）
{
  const codes = [mk('drum', 'hitfinish', 0)]
  const r = planDefaultNames(codes, { 'drum-hitfinish': 'x1Y' })
  ok(r.names[soundCodeKey(codes[0])] === 'Xy', 'x1Y -> Xy')
}

// 6) 弹窗里的默认名：预置优先，剩下的补自动名
{
  const { buildDefaultNames } = await import('../src/components/SoundImportDialog')
  const codes = [mk('normal', 'hitwhistle', 0), mk('normal', 'hitclap', 0), mk('normal', 'hitclap', 1)]
  const keys = codes.map((c) => soundCodeKey(c))
  const rows = codes.map((c, i) => ({ code: c, key: keys[i], count: 1 }))
  const preset = planDefaultNames(codes, { 'normal-hitwhistle': 'Ka, =', 'normal-hitclap': 'Ha' })
  const names = buildDefaultNames(rows, preset.whiteboard, preset.names)
  ok(names[keys[0]] === 'Ka', '弹窗：预设 Ka 生效')
  ok(names[keys[1]] === 'Ha', '弹窗：clap 用 Ha')
  ok(names[keys[2]] === 'Aa', '弹窗：没预设的补 Aa')
  const wb = buildDefaultNames(rows, keys[1], preset.names)
  ok(wb[keys[0]] === 'Ka' && wb[keys[1]] === '', '弹窗：切换白板后该行清空、其他保留')
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
process.exit(bad ? 1 : 0)
