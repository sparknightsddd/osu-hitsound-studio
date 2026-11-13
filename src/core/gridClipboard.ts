/**
 * 格子视图内部剪贴板：存「每个选中的格子有哪些代号 + 音量/编号」。
 *
 * 不跟系统剪贴板混：系统剪贴板只放一份方便人看的文本（`Aa Ab+Ac …`），
 * 真正粘贴用的是这里的结构化数据，音量和编号不会丢。
 *
 * 除了格子内容，还要记住复制块的**形状**：复制一竖排（跨多行、同一列）时，
 * 粘贴必须按「行/列偏移」铺回去。早期只存一串格子、粘贴按阅读顺序往后铺，
 * 结果竖排会被摊成横排（相差一格 = 1/4 拍）。
 */
export interface ClipCell {
  names: string[]
  volume: number
  index: number
}

/** 剪贴板里的一格：dr/dc 是相对复制块左上角的行/列偏移 */
export interface ClipItem {
  dr: number
  dc: number
  cell: ClipCell
}

export interface GridClip {
  items: ClipItem[]
  /** 复制块的外接行数 / 列数（单格 = 1×1） */
  rows: number
  cols: number
  /** true = 矩形块（粘贴按 2D 偏移铺）；false = 线性一串（按阅读顺序往后铺） */
  rect: boolean
  /** 复制时在哪种模式：hitsound 的格子不要粘到 keysound 谱表上 */
  mode?: 'hitsound' | 'keysound'
  /**
   * 复制时所在文件 + 被复制的格子键（`mi:k`）。
   * 复制后源选区通常还亮着，用户再 Ctrl 点目标格时它会一起算进选区；
   * 粘贴时如果这些格子还在同一份谱里被选中，要把它们从锚点里排除，
   * 否则「复制 ABCD → Ctrl 点 5/9/13 → 粘贴」会把源选区也当成一个锚点。
   */
  sourceFileId?: string
  sourceKeys?: string[]
}

let clip: GridClip | null = null

export function setGridClip(c: GridClip) {
  clip = {
    rows: c.rows,
    cols: c.cols,
    rect: c.rect,
    mode: c.mode,
    sourceFileId: c.sourceFileId,
    sourceKeys: c.sourceKeys ? [...c.sourceKeys] : undefined,
    items: c.items.map((it) => ({ dr: it.dr, dc: it.dc, cell: { ...it.cell, names: [...it.cell.names] } })),
  }
}

export function getGridClip(): GridClip | null {
  return clip
}

export function hasGridClip(): boolean {
  return !!clip && clip.items.length > 0
}

/** 剪贴板里一共有几格（单格铺满选区时用） */
export function gridClipCount(): number {
  return clip ? clip.items.length : 0
}
