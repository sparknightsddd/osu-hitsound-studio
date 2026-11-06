/**
 * 编辑器内置的 osu! 官方默认音效清单。
 *
 * 对应的文件是 `public/osudefaulthitsound/default.<ref>.wav`（打包后仍在同一路径），
 * 谱面里的写法是 `hitsound <槽位> <代号> = default.<ref>`（不加引号，解析器按前缀识别）。
 *
 * 音效库下半层列的就是这一份：上层是音效文件夹里的文件，分隔线下面换成内置的这批。
 */

/** 内置音效的引用名（`default.` 后面那一截） */
export const BUILTIN_SOUND_REFS: string[] = [
  // soft
  'soft-hitnormal',
  'soft-hitwhistle',
  'soft-hitfinish',
  'soft-hitclap',
  'soft-slidertick',
  'soft-sliderslide',
  'soft-sliderwhistle',
  // normal
  'normal-hitnormal',
  'normal-hitwhistle',
  'normal-hitfinish',
  'normal-hitclap',
  'normal-slidertick',
  'normal-sliderslide',
  'normal-sliderwhistle',
  // drum
  'drum-hitnormal',
  'drum-hitwhistle',
  'drum-hitfinish',
  'drum-hitclap',
  'drum-slidertick',
  'drum-sliderslide',
  'drum-sliderwhistle',
  // 官方静音文件（导入 .osu 时「白板」用它）
  'blank',
]

/** 某个引用名在清单里吗（导入/导出时想做校验可以用） */
export function isBuiltinSoundRef(ref: string): boolean {
  return BUILTIN_SOUND_REFS.includes(ref)
}
