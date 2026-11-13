/**
 * 语言包检查：
 *  - 源码里所有 `t('…')` / `tr('…')` 的 msgid 都在 en-US.lang 里有翻译；
 *  - `{name}` 这类占位符在原文和译文里一致；
 *  - 列出 lang 里已经没人用的 key（只提示，不算失败）。
 *
 * 用法：npx tsx scripts/check-i18n.ts
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/i18n/langs/en-US.lang'), 'utf8')) as {
  messages: Record<string, string>
}
const msgs = pack.messages

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'i18n' || e.name === 'node_modules') continue
      walk(p, out)
    } else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

const files = walk(path.join(ROOT, 'src'))
const used = new Map<string, string>()
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8')
  const re = /(?<![A-Za-z0-9_])(?:t|tr)\(\s*'((?:[^'\\]|\\.)*)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const msg = m[1].replace(/\\'/g, "'")
    if (!used.has(msg)) used.set(msg, path.relative(ROOT, f))
  }
}

const vars = (s: string) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))
const missing: string[] = []
const badVars: string[] = []
for (const [msg, file] of used) {
  const tr = msgs[msg]
  if (tr === undefined) {
    missing.push(`${msg}   (${file})`)
    continue
  }
  const a = [...vars(msg)].sort().join(',')
  const b = [...vars(tr)].sort().join(',')
  if (a !== b) badVars.push(`${msg}\n    原文: {${a}}\n    译文: {${b}}   (${file})`)
}
const unused = Object.keys(msgs).filter((k) => !used.has(k))

console.log(`messages in en-US.lang: ${Object.keys(msgs).length}`)
console.log(`msgids used in src:     ${used.size}`)
if (missing.length) {
  console.log(`\n✗ missing translations (${missing.length}):`)
  for (const m of missing) console.log('  ' + m)
}
if (badVars.length) {
  console.log(`\n✗ placeholder mismatch (${badVars.length}):`)
  for (const m of badVars) console.log('  ' + m)
}
if (unused.length) {
  console.log(`\n· unused keys (${unused.length}, harmless):`)
  for (const k of unused.slice(0, 20)) console.log('  ' + k)
  if (unused.length > 20) console.log(`  …and ${unused.length - 20} more`)
}
// 其它内置语言包：按 en-US 的全部 key 校验覆盖率和占位符
// （zh-CN 是回退基准，messages 为空；动态 t(variable) 的 key 也要算进来）
const extraIds = ['zh-TW', 'ja-JP', 'ko-KR', 'ru-RU']
let packBad = 0
for (const id of extraIds) {
  const file = path.join(ROOT, 'src/i18n/langs', `${id}.lang`)
  if (!fs.existsSync(file)) {
    console.log(`\n✗ 缺少内置语言包 ${id}.lang`)
    packBad++
    continue
  }
  const p = JSON.parse(fs.readFileSync(file, 'utf8')) as { messages?: Record<string, string> }
  const tr = p.messages || {}
  const miss = Object.keys(msgs).filter((k) => !tr[k])
  const bad = Object.keys(msgs).filter((k) => tr[k] && vars(k).size !== vars(tr[k]).size)
  const badList = Object.keys(msgs).filter((k) => {
    if (!tr[k]) return false
    return [...vars(k)].sort().join(',') !== [...vars(tr[k])].sort().join(',')
  })
  console.log(`\n${id}.lang: ${Object.keys(tr).length}/${Object.keys(msgs).length} entries`)
  if (miss.length) {
    console.log(`  ✗ missing (${miss.length}): ${miss.slice(0, 8).join(' | ')}`)
    packBad += miss.length
  }
  if (badList.length) {
    console.log(`  ✗ placeholder mismatch (${badList.length}): ${badList.slice(0, 8).join(' | ')}`)
    packBad += badList.length
  }
  if (!miss.length && !badList.length) console.log('  ✓ complete, placeholders match')
}

if (!missing.length && !badVars.length && !packBad) console.log('\n✓ all UI strings translated, placeholders match')
process.exit(missing.length || badVars.length || packBad ? 1 : 0)
