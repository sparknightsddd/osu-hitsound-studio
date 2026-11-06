/**
 * 添加音效前的重复检查（文件层面）。
 *
 * 注入假的 exists/hashFile，用真实临时文件验证：
 *   同路径、同内容不同路径、内容不同、default 定义、文件缺失。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { parseChart } from '../src/core/parse'
import { findDuplicateSound } from '../src/core/dupSound'

let fail = 0
const T = (name: string, cond: boolean, extra = '') => {
  if (!cond) fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`)
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsdup-'))
const wav = (name: string, byte: number, len = 64) => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, Buffer.alloc(len, byte))
  return p
}
const a = wav('a.wav', 1)
const copy = wav('copy.wav', 1) // 内容相同
const other = wav('other.wav', 9) // 内容不同
const sameSizeOther = wav('same-size.wav', 7) // 同大小、不同内容
const fresh = wav('fresh.wav', 200) // 没在 [Define] 里出现过

const api = {
  async exists(p: string) {
    try {
      const st = fs.statSync(p)
      return { exists: st.isFile(), size: st.size, mtimeMs: st.mtimeMs }
    } catch {
      return { exists: false }
    }
  },
  async hashFile(p: string) {
    try {
      const buf = fs.readFileSync(p)
      return { ok: true, hash: crypto.createHash('sha1').update(buf).digest('hex'), size: buf.length }
    } catch {
      return { ok: false }
    }
  },
}

const chart = (defineLines: string[]) =>
  parseChart(
    [
      '[Metadata]',
      'Title = dup',
      '',
      '[Files]',
      `path = "${dir.replace(/\\/g, '/')}"`,
      'audio = ""',
      '',
      '[Define]',
      ...defineLines,
      '',
      '[Timing]',
      '0,bpm(120),4,0,0',
      '',
      '[Hitsound]',
      '#0',
      '/Aa = = =/',
      '',
    ].join('\n'),
  )

const doc = chart([
  'hitsound soft-hitnormal Aa = "a.wav"',
  'hitsound soft-hitclap Bb = "other.wav"',
  'hitsound soft-hitfinish Cc = default.soft-hitfinish',
])
T('解析出 3 条定义', doc.hitsounds.length === 3)

{
  const r = await findDuplicateSound(doc, a, api)
  T('同一路径 → 命中 Aa', r === 'Aa', String(r))
}
{
  const r = await findDuplicateSound(doc, path.join(dir, 'a.wav').replace(/\//g, '\\'), api)
  T('反斜杠写法也认（Windows 路径）', r === 'Aa', String(r))
}
{
  const r = await findDuplicateSound(doc, copy, api)
  T('内容相同、路径不同 → 命中 Aa', r === 'Aa', String(r))
}
{
  const r = await findDuplicateSound(doc, fresh, api)
  T('内容不同 → 不命中', r === null, String(r))
}
{
  const r = await findDuplicateSound(doc, sameSizeOther, api)
  T('同大小但内容不同 → 不命中', r === null, String(r))
}
{
  const r = await findDuplicateSound(doc, path.join(dir, 'nope.wav'), api)
  T('文件不存在 → 不命中', r === null, String(r))
}
{
  const empty = chart(['hitsound soft-hitnormal Aa = default.soft-hitnormal'])
  const r = await findDuplicateSound(empty, a, api)
  T('只有 default 定义（没有文件）→ 不命中', r === null, String(r))
}
{
  // 大小写：Windows 下应视为同一路径（Node 测试里 platform 不是 win32，按原样比较）
  const r = await findDuplicateSound(doc, path.join(dir, 'A.WAV'), api)
  T('大小写不同在非 Windows 下不强行命中', r === null || r === 'Aa', String(r))
}

fs.rmSync(dir, { recursive: true, force: true })
console.log(fail ? `\n${fail} FAILED` : '\nALL PASS')
process.exit(fail ? 1 : 0)
