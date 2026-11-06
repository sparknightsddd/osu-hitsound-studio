/**
 * 「把所有音效收进谱面文件夹」的纯规划测试。
 *
 * 覆盖：
 *  - 复制清单：相对/绝对路径都复制成 `<代号>.<原扩展名>`；
 *  - 源文件不动（只产出 copy 计划，不 rename）；
 *  - [Define] 只改路径，颜色/槽位保持；
 *  - 删掉 [Files] path；
 *  - default.xxx 与 keysound 多文件跳过；
 *  - 没写 path 时以 .hs 所在目录为基准。
 */
import { parseChart } from '../src/core/parse'
import { planSoundBundle } from '../src/core/bundle'

const TEXT = `[Metadata]
Title = bundle

[Files]
path = "C:/charts/target"
audio = "song.wav"

[Define]
hitsound soft-hitnormal Aa = "sounds/hitnormal.wav"
hitsound soft-hitclap Ab = "C:/other/clap.OGG" #FF0000
hitsound custom Ac = default.hitclap
keysound custom piano = ("piano/<loop("A","L","B","C")><int((i+9)/12)>.wav", A0, B0)

[Timing]
0,bpm(120),4,0,0

[Hitsound]
#0
/Aa = Ab = = =/`

const doc = parseChart(TEXT, { baseDir: 'C:/charts' })
const plan = planSoundBundle(doc, 'C:/charts/bundle.hs')

let pass = 0
let fail = 0
const T = (name: string, cond: boolean, extra = '') => {
  if (cond) pass++
  else fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
}

console.log('PLAN', JSON.stringify({ ...plan, text: undefined }))
T('目标目录取 [Files] path', plan.targetDir.replace(/\\/g, '/') === 'C:/charts/target', plan.targetDir)
T('复制两个真实文件', plan.copies.length === 2, JSON.stringify(plan.copies))
const a = plan.copies.find((c) => c.code === 'Aa')
const b = plan.copies.find((c) => c.code === 'Ab')
T('相对路径解析后复制成 Aa.wav', !!a && a.fileName === 'Aa.wav' && /hitnormal\.wav$/i.test(a.from), JSON.stringify(a))
T('绝对路径复制成 Ab.OGG（保留扩展名大小写）', !!b && b.fileName === 'Ab.OGG' && /clap\.OGG$/i.test(b.from), JSON.stringify(b))
T('default.xxx 不复制', !plan.copies.some((c) => c.code === 'Ac'))
T('keysound 多文件跳过并记录原因', plan.skips.some((s) => s.code === 'piano'), JSON.stringify(plan.skips))
T('[Define] 改写两条', plan.rewritten === 2, String(plan.rewritten))
T('[Files] path 已删除', plan.removedPath === true)
T('文本里没有 path 行', !/^\s*path\s*=/im.test(plan.text), plan.text)
T('Aa 的路径改成 Aa.wav', /Aa\s*=\s*"Aa\.wav"/.test(plan.text), plan.text)
T('Ab 保留颜色 #FF0000', /Ab\s*=\s*"Ab\.OGG"\s+#FF0000/i.test(plan.text), plan.text)
T('default 定义保持原样', /Ac\s*=\s*default\.hitclap/.test(plan.text))
T('keysound 定义保持原样', /piano\s*=\s*\("piano\//.test(plan.text))
T('其它段落没被破坏', /\[Timing\]/.test(plan.text) && /\[Hitsound\]/.test(plan.text))

// 没有 [Files] path：以 .hs 所在目录为基准
const NO_PATH = TEXT.replace('path = "C:/charts/target"\n', '')
const doc2 = parseChart(NO_PATH, { baseDir: 'C:/charts/sub' })
const plan2 = planSoundBundle(doc2, 'C:/charts/sub/bundle.hs')
console.log('PLAN2', JSON.stringify({ ...plan2, text: undefined }))
T('无 path：目标目录 = .hs 所在目录', plan2.targetDir.replace(/\\/g, '/') === 'C:/charts/sub', plan2.targetDir)
T('无 path：相对音效按 .hs 目录解析', /^C:[\\/]charts[\\/]sub[\\/]sounds[\\/]hitnormal\.wav$/i.test(plan2.copies[0]?.from || ''), plan2.copies[0]?.from)
T('无 path：removedPath 为 false', plan2.removedPath === false)

// 已经在目标目录且已经叫代号：不复制
const ALREADY = `[Metadata]
Title = done

[Files]
audio = "song.wav"

[Define]
hitsound soft-hitnormal Aa = "Aa.wav"

[Timing]
0,bpm(120),4,0,0

[Hitsound]
#0
/Aa = = = =/`
const plan3 = planSoundBundle(parseChart(ALREADY, { baseDir: 'C:/charts/done' }), 'C:/charts/done/x.hs')
console.log('PLAN3', JSON.stringify({ ...plan3, text: undefined }))
T('已经是代号文件名：不复制', plan3.copies.length === 0, JSON.stringify(plan3.copies))
T('已经是代号文件名：文本不变', plan3.text === parseChart(ALREADY, { baseDir: 'C:/charts/done' }).text)

// [Files] path 写相对路径：相对 .hs 所在目录解析
const REL = TEXT.replace('path = "C:/charts/target"', 'path = "target"')
const docRel = parseChart(REL, { baseDir: 'C:/charts' })
T('[Files] path 可以写相对路径', docRel.baseDir.replace(/\\/g, '/') === 'C:/charts/target', docRel.baseDir)
T('相对 path 下的音效也能解析', /charts[\\/]target[\\/]sounds[\\/]hitnormal\.wav$/i.test(docRel.hitsounds[0]?.resolvedPath || ''), docRel.hitsounds[0]?.resolvedPath)
T('settings.Path 保留原文（用于显示/写回）', docRel.settings.Path === 'target', docRel.settings.Path)

console.log(`RESULT ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)