/**
 * 导入默认颜色：12 个槽位各一个色，写进 [Define] 第五段；
 * 同一槽位的第 2、3 个代号做深浅变化；设置里改过就用改过的。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_COMBO_COLORS, COMBO_KEYS, planDefaultColors, comboColor } from '../src/core/importPrefs'
import { parseChart } from '../src/core/parse'
import { extractOsuSounds } from '../src/core/osuSounds'
import { renderOsuSoundsHs } from '../src/core/osuToHs'

let bad = 0
function ok(cond: boolean, name: string) {
  if (!cond) {
    bad++
    console.log(`FAIL ${name}`)
  } else console.log(`ok   ${name}`)
}

function code(
  set: 'soft' | 'normal' | 'drum',
  hit: 'hitnormal' | 'hitwhistle' | 'hitfinish' | 'hitclap',
  file = '',
  index = 1,
) {
  return {
    name: 'Zz',
    sampleSet: set,
    hitType: hit,
    index,
    file,
    slot: `${set}-${hit}`,
    usedAs: [`${set}-${hit}`],
    value: file ? `"${file}"` : `default.${set}-${hit}`,
  } as never
}

// 1) 12 个默认色互不相同、都是合法色号
const vals = COMBO_KEYS.map((k) => DEFAULT_COMBO_COLORS[k])
ok(vals.length === 12, `12 个槽位：${vals.length}`)
ok(new Set(vals).size === 12, `默认色互不重复：${new Set(vals).size}`)
ok(vals.every((v) => /^#[0-9a-f]{6}$/i.test(v)), '都是 #rrggbb')

// 2) planDefaultColors：按槽位给色，同槽位第二个代号变深/变浅
{
  const codes = [
    code('soft', 'hitclap', 'a.wav', 1),
    code('soft', 'hitclap', 'b.wav', 2),
    code('drum', 'hitwhistle', 'c.wav', 1),
  ]
  const map = planDefaultColors(codes)
  const list = Object.values(map)
  ok(list.length === 3, `三个 code 都有颜色：${list.length}`)
  ok(list[0] === DEFAULT_COMBO_COLORS['soft-hitclap'], `第一个用槽位色：${list[0]}`)
  ok(list[1] !== list[0], `第二个不一样：${list[0]} vs ${list[1]}`)
  ok(list[2] === DEFAULT_COMBO_COLORS['drum-hitwhistle'], `别的槽位不受影响：${list[2]}`)
}

// 3) 设置里改过 → 用改过的
{
  const map = planDefaultColors([code('normal', 'hitfinish')], { 'normal-hitfinish': '#123456' })
  ok(Object.values(map)[0] === '#123456', `自定义颜色生效：${Object.values(map)[0]}`)
  ok(comboColor('normal-hitfinish') === DEFAULT_COMBO_COLORS['normal-hitfinish'], '没改时回落到默认')
}

// 4) 生成出来的 [Define] 带颜色，且能被解析器读回来
{
  const head = (def: string) => `[Metadata]
Title = color

[Files]
path = ""
audio = ""

[Define]
${def}

[Timing]
0,bpm(120),4,0,0

[Hitsound]
#0
/Aa/
`
  const text = head('hitsound soft-hitclap Aa = "a.wav" #ff8800\nhitsound drum-hitwhistle Ab = default.drum-hitwhistle #00ffcc')
  const doc = parseChart(text)
  const a = doc.hitsounds.find((h) => h.name === 'Aa')
  const b = doc.hitsounds.find((h) => h.name === 'Ab')
  ok(a?.color === '#ff8800', `解析到颜色：${a?.color}`)
  ok(b?.color === '#00ffcc', `default 定义也能带色：${b?.color}`)
  ok(doc.diagnostics.filter((d) => d.severity === 'error').length === 0, '没有解析错误')
}

// 5) 走一遍真实导入：生成的 [Define] 每行都带颜色，且能解析回来
{
  const dir = mkdtempSync(join(tmpdir(), 'hscolor-'))
  writeFileSync(join(dir, 'soft-hitclap.wav'), 'x')
  writeFileSync(join(dir, 'drum-hitwhistle.wav'), 'x')
  const osu = `osu file format v14

[General]
AudioFilename: audio.mp3
SampleSet: Soft

[Metadata]
Title:color
Artist:tester
Creator:tester
Version:test

[TimingPoints]
0,500,4,2,0,60,1,0
4000,500,4,3,1,60,1,0

[HitObjects]
256,192,0,1,8,0:0:0:0:
256,192,1000,1,2,0:0:0:0:
256,192,4000,1,2,0:0:0:0:
`
  const env = {
    dir,
    fileName: 'color.osu',
    fileExists: async (d: string, rel: string) => existsSync(join(d, rel)),
    hashFile: async (_d: string, rel: string) => 'h:' + rel,
    audioDurationMs: async () => 0,
  }
  const ex = await extractOsuSounds(osu, env as never)
  const out = renderOsuSoundsHs(ex, { path: dir, codeColors: planDefaultColors(ex.codes) })
  const define = out.text.split('[Define]')[1].split('[Timing]')[0]
  const lines = define.split('\n').filter((l) => l.startsWith('hitsound '))
  ok(lines.length === ex.codes.length, `每个音效一行：${lines.length}/${ex.codes.length}`)
  ok(lines.every((l) => / #[0-9a-f]{6}$/.test(l)), `每行都带颜色：\n${lines.join('\n')}`)
  ok(
    lines.some((l) => l.includes('soft-hitclap') && l.endsWith(DEFAULT_COMBO_COLORS['soft-hitclap'])) &&
      lines.some((l) => l.includes('drum-hitwhistle') && l.endsWith(DEFAULT_COMBO_COLORS['drum-hitwhistle'])),
    '槽位与颜色一一对应',
  )
  const doc = parseChart(out.text)
  ok(doc.hitsounds.every((h) => !!h.color), `解析后都有 color：${doc.hitsounds.map((h) => h.color).join(' ')}`)
  ok(doc.diagnostics.filter((d) => d.severity === 'error').length === 0, '生成的文件没有解析错误')
  rmSync(dir, { recursive: true, force: true })
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
if (bad) process.exit(1)
