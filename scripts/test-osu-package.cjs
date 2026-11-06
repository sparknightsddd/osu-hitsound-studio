/**
 * 导出命名 / 重名规则单测（主进程逻辑，不启动 Electron）。
 *
 * 覆盖：
 * - 文件名 `<artist> - <title> (<creator>) [[EZHS]].osu`
 * - 重名 → `[EZHS1]`、`[EZHS2]`，Version 跟着变
 * - 音效同名且内容一致 → 跳过
 * - 音效同名但内容不同 → 整体中止，一个文件都不写
 * - [Files] path 无效 → 报错
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  exportPackage,
  pickFreeName,
  osuBaseName,
  sanitizeName,
  cleanOldExports,
} = require('../electron/osu-export.cjs')

let bad = 0
function ok(cond, name) {
  if (!cond) {
    bad++
    console.log(`FAIL ${name}`)
  } else console.log(`ok   ${name}`)
}

const SRC = 'E:/osu/Songs/Starlight Kuku Gumi - Watashi tachi wa mou Butai no ue (SparkNights)'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hspkg-'))

const text = `osu file format v14

[Metadata]
Title:Test Song
Artist:Some Artist
Creator:Mapper
Version:Hitsound

[HitObjects]
256,192,1000,1,1,2:2:11:60:
`

const files = [
  { to: 'soft-hitnormal11.wav', from: [path.join(SRC, 'soft-hitnormal8.wav')], defaults: [], mix: false },
  { to: 'soft-hitclap11.wav', from: [path.join(SRC, 'soft-hitclap8.wav')], defaults: [], mix: false },
  {
    to: 'normal-hitclap11.wav',
    from: [path.join(SRC, 'normal-hitclap18.wav'), path.join(SRC, 'soft-hitclap8.wav')],
    defaults: [],
    mix: true,
    mixMeta: { v: 1, app: 'osu-hitsound-studio', sources: [{ code: 'Aa', set: 'soft', hit: 'hitclap', index: 11, file: 'a.wav' }] },
  },
]

const base = { artist: 'Some Artist', title: 'Test Song', creator: 'Mapper' }

// 0) 文件名清洗
{
  ok(sanitizeName('A/B: C?') === 'A_B_ C_', `非法字符替换：${sanitizeName('A/B: C?')}`)
  ok(osuBaseName({ artist: 'A', title: 'T', creator: 'C' }) === 'A - T (C)', '带 creator')
  ok(osuBaseName({ artist: 'A', title: 'T', creator: '' }) === 'A - T', '没有 creator 时不带括号')
}

// 1) 第一次导出
{
  const r = exportPackage({ dir, ...base, text, files })
  ok(r.ok, `导出成功：${r.error || ''}`)
  ok(path.basename(r.osuPath) === 'Some Artist - Test Song (Mapper) [[EZHS]].osu', `文件名：${path.basename(r.osuPath)}`)
  ok(r.diff === '[EZHS]', `难度名：${r.diff}`)
  const out = fs.readFileSync(r.osuPath, 'utf8')
  ok(out.includes('Version:[EZHS]'), `Version 行跟着改：${/Version:.*/.exec(out)?.[0]}`)
  ok(r.written === 3 && r.skipped === 0, `写出 ${r.written} 个、跳过 ${r.skipped} 个`)
  for (const f of files) ok(fs.existsSync(path.join(dir, f.to)), `${f.to} 已落盘`)
  const mixed = fs.readFileSync(path.join(dir, 'normal-hitclap11.wav'))
  ok(mixed.length > 0 && mixed.toString('ascii', 0, 4) === 'RIFF', '混音文件是合法 WAV')
}

// 2) 再导出一次：.osu 换 [EZHS1]，音效内容一致全部跳过
{
  const r = exportPackage({ dir, ...base, text, files })
  ok(r.ok && r.diff === '[EZHS1]', `重名难度名递增：${r.diff}`)
  ok(path.basename(r.osuPath) === 'Some Artist - Test Song (Mapper) [[EZHS1]].osu', `文件名：${path.basename(r.osuPath)}`)
  ok(r.written === 0 && r.skipped === 3, `全部跳过：写 ${r.written} / 跳 ${r.skipped}`)
  ok(fs.readFileSync(r.osuPath, 'utf8').includes('Version:[EZHS1]'), 'Version 也跟着变')
}

// 3) 目录里有个同名但内容不同的文件 → 整体中止
{
  const target = path.join(dir, 'soft-hitclap11.wav')
  fs.writeFileSync(target, Buffer.from('someone else wav'))
  const before = fs.readdirSync(dir).sort().join('|')
  const r = exportPackage({ dir, ...base, text, files })
  ok(r.ok === false && r.conflict === true, `检测到冲突：${JSON.stringify(r.conflicts)}`)
  ok((r.conflicts || []).includes('soft-hitclap11.wav'), `冲突文件正确：${r.conflicts}`)
  ok(fs.readdirSync(dir).sort().join('|') === before, '冲突时一个文件都没写（连 .osu 都没有）')
  ok(fs.readFileSync(target, 'utf8') === 'someone else wav', '已有的不同内容文件没被覆盖')
}

// 4) 目录无效
{
  const r = exportPackage({ dir: path.join(dir, 'not-exist'), ...base, text, files })
  ok(!r.ok && /不存在/.test(r.error || ''), `目录不存在时报错：${r.error}`)
}

// 5) pickFreeName：连续占用时的顺序
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hspkg2-'))
  fs.writeFileSync(path.join(d, 'X - Y [[EZHS]].osu'), '')
  ok(pickFreeName(d, 'X - Y').diff === '[EZHS1]', 'EZHS 占用 → EZHS1')
  fs.writeFileSync(path.join(d, 'X - Y [[EZHS1]].osu'), '')
  ok(pickFreeName(d, 'X - Y').diff === '[EZHS2]', 'EZHS1 也占用 → EZHS2')
  fs.rmSync(d, { recursive: true, force: true })
}

// 6) cleanOldExports：只删同一个 base 的 [[EZHS*]].osu
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hspkg3-'))
  const keep = ['Other - Song (C) [[EZHS]].osu', 'X - Y [Hard].osu', 'X - Y [[EZHS]].wav']
  for (const n of ['X - Y [[EZHS]].osu', 'X - Y [[EZHS1]].osu', 'X - Y [[EZHS12]].osu', ...keep]) {
    fs.writeFileSync(path.join(d, n), '')
  }
  const removed = cleanOldExports(d, 'X - Y')
  ok(removed.length === 3, `删掉 3 个旧导出：${removed.join(', ')}`)
  const left = fs.readdirSync(d).sort()
  ok(left.length === keep.length && keep.every((n) => left.includes(n)), `别的谱和别的格式没动：${left.join(', ')}`)
  fs.rmSync(d, { recursive: true, force: true })
}

// 7) cleanOld 导出：重复导出只留一份 [EZHS].osu
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hspkg4-'))
  const r1 = exportPackage({ dir: d, ...base, text, files })
  const r2 = exportPackage({ dir: d, ...base, text, files, cleanOld: true })
  ok(r2.ok && r2.diff === '[EZHS]', `清理后重新用 [EZHS]：${r2.diff}`)
  ok((r2.removed || []).length === 1, `删掉了上一份：${r2.removed}`)
  const osu = fs.readdirSync(d).filter((n) => n.endsWith('.osu'))
  ok(osu.length === 1 && osu[0] === 'Some Artist - Test Song (Mapper) [[EZHS]].osu', `目录里只剩一份：${osu.join(', ')}`)
  ok(r2.written === 0 && r2.skipped === 3, '音效内容一致全部跳过')
  ok(r1.ok && r2.ok, '两次都成功')

  // 8) 有音效冲突时不能先清理
  fs.writeFileSync(path.join(d, 'soft-hitnormal11.wav'), Buffer.from('changed'))
  const before = fs.readdirSync(d).sort().join('|')
  const r3 = exportPackage({ dir: d, ...base, text, files, cleanOld: true })
  ok(r3.conflict === true, '冲突照常报告')
  ok(fs.readdirSync(d).sort().join('|') === before, '冲突时旧的 [EZHS].osu 没有被删')
  fs.rmSync(d, { recursive: true, force: true })
}

fs.rmSync(dir, { recursive: true, force: true })
console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
process.exitCode = bad ? 1 : 0
