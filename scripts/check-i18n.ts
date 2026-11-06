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
if (!missing.length && !badVars.length) console.log('\n✓ all UI strings translated, placeholders match')
process.exit(missing.length || badVars.length ? 1 : 0)
