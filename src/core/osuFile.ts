/**
 * `.osu` 文件的「是不是正经谱面」检查。
 *
 * 目的：挡住「随便写个 .txt 再把后缀改成 .osu」这类文件 ——
 * 它们能被当文本读出来，但 `[TimingPoints]` / `[HitObjects]` 全是空的，
 * 导进去只会得到一份莫名其妙的空谱。
 *
 * 判定标准（和 osu! 本体一致的最小集）：
 *   1. 第一行（跳过空行和 `//` 注释）是 `osu file format vN`；
 *   2. 至少有一个已知段落，如 `[General]` / `[TimingPoints]` / `[HitObjects]`。
 */
export type OsuFileProblem = 'empty' | 'header' | 'sections'

const OSU_SECTIONS = /^\[(General|Editor|Metadata|Difficulty|Events|TimingPoints|Colours|HitObjects)\]\s*$/im

/** 检查一段文本像不像 .osu；返回 null 表示没问题 */
export function osuFileProblem(text: string): OsuFileProblem | null {
  const body = String(text || '').replace(/^\uFEFF/, '')
  const first = body.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('//'))
  if (!first) return 'empty'
  if (!/^osu file format v\d+\s*$/i.test(first.trim())) return 'header'
  if (!OSU_SECTIONS.test(body)) return 'sections'
  return null
}

export function isOsuFileText(text: string): boolean {
  return osuFileProblem(text) === null
}
