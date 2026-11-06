/**
 * 导出音效包的落盘逻辑（主进程，CommonJS）。
 *
 * 规则：
 * - 直接写进 [Files] path，不再选目录；
 * - .osu 文件名 `<artist> - <title> (<creator>) [[EZHS]].osu`，重名时难度名依次变
 *   `[EZHS1]`、`[EZHS2]`…（文件名里的方括号会叠成 `[[EZHS1]]`）；
 * - 音效重名：内容一致就跳过，不一致就整体中止并列出冲突文件，让用户先移走。
 */
const fs = require('node:fs')
const path = require('node:path')
const { mixBuffers } = require('./wav-mix.cjs')

/** 文件名里不能出现的字符换成下划线 */
function sanitizeName(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
}

/** `<artist> - <title> (<creator>)`；creator 为空就不带括号 */
function osuBaseName(opts) {
  const a = sanitizeName(opts.artist) || 'Unknown Artist'
  const t = sanitizeName(opts.title) || 'Unknown Title'
  const c = sanitizeName(opts.creator)
  return c ? `${a} - ${t} (${c})` : `${a} - ${t}`
}

/**
 * 找一个没被占用的难度名。
 * 文件名格式是 `<base> [<难度名>].osu`，难度名本身带方括号 → `... [[EZHS]].osu`。
 */
function pickFreeName(dir, base) {
  for (let n = 0; n < 1000; n++) {
    const diff = n === 0 ? '[EZHS]' : `[EZHS${n}]`
    const file = `${base} [${diff}].osu`
    if (!fs.existsSync(path.join(dir, file))) return { diff, file }
  }
  const diff = '[EZHS999]'
  return { diff, file: `${base} [${diff}].osu` }
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 删掉本谱之前导出的 `[[EZHS]].osu` / `[[EZHS1]].osu`…
 * 只匹配同一个 `<base>`，不会碰目录里别的谱。
 */
function cleanOldExports(dir, base) {
  const removed = []
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return removed
  }
  const re = new RegExp(`^${escapeRe(base)} \\[\\[EZHS\\d*\\]\\]\\.osu$`, 'i')
  for (const n of names) {
    if (!re.test(n)) continue
    try {
      fs.unlinkSync(path.join(dir, n))
      removed.push(n)
    } catch {
      /* 删不掉（只读/占用）就留着，不影响本次导出 */
    }
  }
  return removed
}

/** 只有 [Metadata] 的 Version 要跟着难度名走 */
function setVersion(text, diff) {
  return text.replace(/^(Version:)[^\r\n]*/m, `$1${diff}`)
}

function readSafe(file) {
  try {
    return fs.readFileSync(file)
  } catch {
    return null
  }
}

/**
 * 执行导出。
 * @param opts {dir, artist, title, creator, text, files, defaultDir}
 * @returns {
 *   ok, dir, osuPath, diff, written, skipped, conflicts, errors, error?, conflict?
 * }
 */
function exportPackage(opts) {
  const dir = String(opts.dir || '').trim()
  if (!dir) return { ok: false, error: '[Files] path 为空，不知道导出到哪' }
  let st = null
  try {
    st = fs.statSync(dir)
  } catch {
    st = null
  }
  if (!st || !st.isDirectory()) return { ok: false, error: `导出目录不存在：${dir}` }

  const base = osuBaseName(opts)
  const errors = []
  const conflicts = []
  const writes = []
  const skipped = []

  for (const f of opts.files || []) {
    const name = path.basename(String(f.to || ''))
    if (!name) continue
    const to = path.join(dir, name)
    const from = (f.from || []).filter(Boolean)

    let buffer = null
    if (f.mix) {
      const sources = [...from]
      for (const ref of f.defaults || []) {
        const p = path.join(opts.defaultDir || '', `default.${ref}.wav`)
        if (opts.defaultDir && fs.existsSync(p)) sources.push(p)
        else errors.push(`${name}：内置音效缺失 default.${ref}.wav`)
      }
      if (!sources.length) {
        errors.push(`${name}：没有可混音的源文件`)
        continue
      }
      // 单源且不需要写混音信息 → 等价于复制，别白跑一遍重编码
      if (sources.length === 1 && !f.mixMeta) {
        buffer = readSafe(sources[0])
      } else {
        const r = mixBuffers(sources, f.mixMeta)
        if (!r.ok) {
          errors.push(`${name}：${r.errors.join('；') || '混音失败'}`)
          continue
        }
        buffer = r.buffer
      }
      if (!buffer) {
        errors.push(`${name}：读不到源文件`)
        continue
      }
    } else if (from.length) {
      buffer = readSafe(from[0])
      if (!buffer) {
        errors.push(`${name}：读不到 ${from[0]}`)
        continue
      }
    }
    if (!buffer) continue

    if (fs.existsSync(to)) {
      const have = readSafe(to)
      // 内容完全一致 → 这份音效已经导出过，跳过
      if (have && have.equals(buffer)) {
        skipped.push(name)
        continue
      }
      conflicts.push(name)
      continue
    }
    writes.push({ to, buffer })
  }

  // 有冲突就一个文件都不写，避免导出一半；也不动旧 .osu（先检查、后清理）
  if (conflicts.length) {
    return { ok: false, conflict: true, dir, conflicts, skipped, errors }
  }

  // 清理旧导出放在选名字之前：删掉 [EZHS].osu / [EZHS1].osu 后可以重新用 [EZHS]
  const removed = opts.cleanOld ? cleanOldExports(dir, base) : []
  const { diff, file } = pickFreeName(dir, base)
  const osuPath = path.join(dir, file)

  try {
    fs.writeFileSync(osuPath, setVersion(String(opts.text || ''), diff), 'utf8')
    for (const w of writes) fs.writeFileSync(w.to, w.buffer)
  } catch (err) {
    return { ok: false, error: String(err) }
  }

  return {
    ok: true,
    dir,
    osuPath,
    diff,
    written: writes.length,
    skipped: skipped.length,
    removed,
    conflicts: [],
    errors,
  }
}

module.exports = { sanitizeName, osuBaseName, pickFreeName, setVersion, cleanOldExports, exportPackage }
