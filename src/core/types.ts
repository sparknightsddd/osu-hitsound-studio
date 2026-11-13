export type Severity = 'error' | 'warning' | 'info'

export interface Diagnostic {
  from: number
  to: number
  severity: Severity
  message: string
  code?: string
}

export type SampleSet = 'soft' | 'normal' | 'drum'
export type HitType =
  | 'hitnormal'
  | 'hitwhistle'
  | 'hitfinish'
  | 'hitclap'
  | 'sliderside'
  | 'slidertick'

/**
 * 副槽位：主槽位下不了音效时的退路。
 * 优先级固定 slidertick > sliderside > successor，和 [Define] 里的书写顺序无关。
 */
export type SubSlot = 'slidertick' | 'sliderside' | 'successor'

/** 固定优先级（越靠前越优先） */
export const SUB_SLOT_ORDER: SubSlot[] = ['slidertick', 'sliderside', 'successor']

export interface SlotAlt {
  raw: string
  custom: boolean
  sampleSet?: SampleSet
  hitType?: HitType
  /** 这个 token 是副槽位（不进 alts，单独记到 HitsoundDef.subSlots） */
  sub?: SubSlot
  from: number
  to: number
}

export interface IndexRange {
  from: number
  to: number
}

export interface HitsoundDef {
  /** 自定义音效名（正文中使用），如 D / Wy / Ni；直接指派到 slot 时为空 */
  name?: string
  /** hitsound（无音高）还是 keysound（有音高） */
  kind: 'hitsound' | 'keysound'
  /** 相对路径按 [Files] 的 path 解析后的完整路径；default.xxx 没有解析结果 */
  resolvedPath?: string
  nameFrom: number
  nameTo: number
  alts: SlotAlt[]
  indices: IndexRange[]
  /**
   * 副槽位（sliderside / slidertick / successor）。
   * 只有主槽位下不了音效时才会用到；优先级固定，见 SUB_SLOT_ORDER。
   */
  subSlots: SubSlot[]
  /** 原始值（default.xxx 或路径） */
  value: string
  /** [Define] 末尾可选的颜色，归一化成 #rrggbb；没写就是 undefined（用默认色） */
  color?: string
  defaultRef?: string
  path?: string
  /** keysound 的定义参数（多文件 / 单文件、音域、preset 等） */
  keys?: KeysoundSpec
  /** keysound 单文件类型：sf2/sf3/sfz/普通音频；多文件为 undefined */
  library?: 'sf2' | 'sf3' | 'sfz' | 'sample'
  /** 音色库文件（.sf2 / .sf3）；保留给旧界面判断 */
  soundFont?: boolean
  /** keysound 多文件模式展开出的「MIDI -> 路径」表 */
  keyFiles?: Map<number, string>
  from: number
  to: number
  line: number
}

/** keysound 的定义参数，对应 `keysound ... = "路径" { ... }` 里的花括号 */
export type KeysoundMode = 'multifile' | 'singlefile'

export interface KeysoundSpec {
  /** multifile = 每个音高一个文件；singlefile = 一个样本/音色库 */
  mode: KeysoundMode
  /**
   * multifile 的路径模板（可含 <list>/<loop>/<int>），或文件列表时的目录前缀；
   * singlefile 为空（实际路径在 HitsoundDef.path）。
   */
  pattern: string
  /** 最低音（MIDI 编号，C4=60） */
  low: number
  /** 最高音（MIDI 编号） */
  high: number
  /** 调律偏移（音分），正值升高 */
  tune: number
  /** multifile 用 `files={...}` 显式列出文件名时，按半音递增 */
  fileList?: string[]
  /** singlefile 的音色库选择；默认值是 0/false */
  bank: number
  preset: number
  program: number
  percussion: boolean
}

export interface PhraseDef {
  name: string
  body: string
  from: number
  to: number
  line: number
}

export interface ListDef {
  name: string
  type: string
  items: string[]
  from: number
  to: number
  line: number
}

export interface TimingPoint {
  offset: number
  beatLength: number
  meter: number
  resetMode: 0 | 1 | 2
  resetBeats: number
  /** 是否显式写了 resetBeats 字段（用于诊断提示） */
  resetBeatsSet: boolean
  shift: number
  from: number
  to: number
  line: number
}

/** 分节符：[Settings] Sections 里的一项。time 处的小节另起一行显示，name 是段落名 */
export interface SectionMark {
  /** 毫秒（与 Bookmarks 同单位） */
  time: number
  name: string
}

export interface Settings {
  /** [Files] 的 path：音效相对路径与 audio 的基准目录 */
  Path: string
  /** [Files] 的 audio：音频文件名或路径 */
  Audio: string
  /** [Files] 的 ImportOsu：导入的 .osu 谱面（只读取物件时间轴，用来对照原谱） */
  ImportOsu: string
  Mode: 'default' | 'taiko' | 'mania'
  Key: string[]
  AutoHitsoundIndex: boolean
  SliderSlideHitsound: boolean
  SliderTickHitsound: boolean
  SpinnerHitsound: boolean
  DefaultOverride: boolean
  StandardFormat: boolean
  PreferredIndex: number[]
  TimingAdsorb: number
  TimingAdsorbRaw: string
  /** 书签时间点（毫秒），与 [Timing] 每行第一项同个单位；正文用 #bookmark(n) 引用 */
  Bookmarks: number[]
  BookmarksRaw: string
  /** 分节符：强制在这些时间对应的小节前换行，并显示段落名与换行标识 */
  Sections: SectionMark[]
  SectionsRaw: string
  /** 已废弃：旧版 [Settings] 的 Song，迁移到 [Files] 的 audio */
  Song: string
}

/** 正文里以单个 "#" 开头的段落标记 */
export interface BodyMarker {
  /** 原始写法去掉 "#" 后的内容 */
  raw: string
  kind: 'ms' | 'clock' | 'bookmark' | 'timing'
  /** #bookmark / #timing 的序号 */
  arg?: number
  /** 解析出的绝对时间（毫秒）；解析失败为 null */
  time: number | null
  /** 落在第几个小节（0 起）；time 为 null 时也是 null */
  measure: number | null
  line: number
  from: number
  to: number
}

export interface NoteEvent {
  /** 绝对时间（毫秒） */
  time: number
  /** 时值长度（毫秒），mania 的面 / taiko 长音用 */
  duration: number
  names: string[]
  volume: number
  index: number | null
  /** 所属小节（1 起） */
  measure: number
  /** 小节内的第几个时值单位（0 起，浮点） */
  unitPos: number
  /** 在小节中的拍数（浮点，0 起） */
  beat: number
  line: number
  from: number
  to: number
  /** hitsound（无音高）还是 keysound（有音高） */
  kind?: 'hitsound' | 'keysound'
  /** keysound 的音高（MIDI 编号） */
  pitch?: number
  /** 所属谱表（0 起），对应 [Keysound] 首行乐器列表的位置 */
  staff?: number
  /** 该谱表使用的乐器名 */
  instrument?: string
}

/** [Keysound] 首行指定的乐器（按谱表顺序） */
export interface KeysoundInstrument {
  name: string
  staff: number
  from: number
  to: number
  line: number
}

/** 小节内的一段，拥有自己的每拍毫秒数（小节内变速时用） */
export interface MeasureSegment {
  start: number
  end: number
  beatLength: number
  /** 本段占几拍（可为小数，例如变更点落在 2.5 拍处） */
  beats: number
}

export interface MeasureInfo {
  index: number
  start: number
  end: number
  /** 小节起点处的每拍毫秒数；小节内变速时请优先使用 segments */
  beatLength: number
  meter: number
  /**
   * 小节内变速分段（按时间升序）。
   * 仅当本小节中途发生 BPM 变更时才存在；为 undefined 表示整小节同一 BPM。
   */
  segments?: MeasureSegment[]
  /**
   * 这一小节在正文里的 `/.../ \` 文本范围（含两侧小节线）。
   *
   * 只有「一行只写一个小节、且没用跨度/重复」的普通写法才会记录；
   * 格子视图写回时就替换这一段，缩进和行尾注释都保留在外侧。
   */
  body?: { from: number; to: number }
  /**
   * [Keysound] 正文里这一小节的写回范围，按谱表下标。
   *
   * 单谱表行是整个 `/.../`；多谱表行（`a | b`）只记自己那一段（bare=true），
   * 替换时不会碰到其它谱表。
   */
  ksBodies?: Record<number, { from: number; to: number; bare?: boolean }>
  /** [Keysound] 里这一小节被跨度 / 重复 / 多区域行覆盖，这些谱表的格子不能写回 */
  ksCovered?: Record<number, boolean>
  /**
   * 这一小节被正文里哪个**区域**覆盖（值为区域起始小节的下标）。
   *
   * - `undefined`：正文里完全没有它的行（两段之间空出来的一大段、谱面末尾的空小节）。
   *   格子视图可以直接补一行 `#标记 + /.../`。
   * - 等于 index 但没有 body：这一行有自己的位置，用了多小节一行 / 重复等写法，
   *   替换该行会牵连别的小节，不能写回。
   * - 小于 index：被跨度（`/5/`）或多小节一行覆盖，同样不能写回。
   */
  coveredBy?: number
}

export interface SectionRange {
  name: string
  from: number
  to: number
}

export interface ChartDoc {
  text: string
  metadata: Record<string, string>
  metadataOrder: string[]
  settings: Settings
  /** [Files] 解析后的完整音频路径 */
  audioPath: string
  /**
   * 解析相对路径时实际使用的基准目录：
   * 有 `[Files] path` 就是它，没有就是 .hs 自己所在的文件夹。
   * 空串表示两份都没有（从未存过盘的新谱）。
   */
  baseDir: string
  /** [Files] ImportOsu 解析后的完整 .osu 路径（未配置为空串） */
  importOsuPath: string
  hitsounds: HitsoundDef[]
  phrases: PhraseDef[]
  lists: ListDef[]
  timing: TimingPoint[]
  events: NoteEvent[]
  /** 小节网格（会超出正文范围，保证 [Timing] 的变速在时间轴上可见） */
  measures: MeasureInfo[]
  /** 正文实际用到的小节数（measures.length 可能大于它） */
  usedMeasures: number
  diagnostics: Diagnostic[]
  sections: SectionRange[]
  /** [Keysound] 首行的乐器列表（按谱表顺序） */
  keyInstruments: KeysoundInstrument[]
  /** 正文里的段落标记（#123456 / #2:03.456 / #bookmark(0) / #timing(0)） */
  markers: BodyMarker[]
  /** 正文中引用到但未定义的音效名 */
  undefinedNames: string[]
}
