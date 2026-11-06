/**
 * 界面显示相关的偏好（应用级，跟具体谱面无关）。
 *
 * - 音效颜色的不透明度是否随音量变化（100 → 0xFF、0 → 0x37）
 * - 格子里怎么显示 `<v=xx>`：数字 / 音量条 / 不显示
 *
 * 用模块内缓存，时间轴每帧读它也不会反复碰 localStorage。
 */

/** 格子里 `<v=xx>` 的显示方式 */
export type VolumeDisplay =
  /** 在格子左边的缝隙里写 2~3 位数字（间距要加宽到 18px 才放得下） */
  | 'number'
  /** 同一位置画一根深绿/浅绿的小竖条（间距保持 4px） */
  | 'bar'
  /** 什么都不画（间距保持 4px） */
  | 'none'

export interface DisplayPrefs {
  colorAlphaByVol: boolean
  volumeDisplay: VolumeDisplay
  /** 网格每行下方显示 [Files] ImportOsu 的物件时间轴（开启时行距会相应加高） */
  showOsuObjects: boolean
}

const LS_KEY = 'hsstudio.display'

/** 旧版本只有一个布尔值 `volumeLabels`：开着是数字、关掉是不显示 */
function migrate(raw: Record<string, unknown> | null): VolumeDisplay {
  const v = raw?.volumeDisplay
  if (v === 'number' || v === 'bar' || v === 'none') return v
  if (typeof raw?.volumeLabels === 'boolean') return raw.volumeLabels ? 'bar' : 'none'
  return 'bar'
}

function defaults(): DisplayPrefs {
  return { colorAlphaByVol: true, volumeDisplay: 'bar', showOsuObjects: true }
}

let cache: DisplayPrefs | null = null

export function getDisplayPrefs(): DisplayPrefs {
  if (cache) return cache
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}') as Record<string, unknown> | null
    cache = {
      colorAlphaByVol: raw?.colorAlphaByVol !== false,
      volumeDisplay: migrate(raw),
      // 旧版本没有这个字段：默认开着（配了 ImportOsu 就能直接看到）
      showOsuObjects: raw?.showOsuObjects !== false,
    }
  } catch {
    cache = defaults()
  }
  return cache
}

export function setDisplayPrefs(p: DisplayPrefs) {
  const mode: VolumeDisplay =
    p.volumeDisplay === 'number' || p.volumeDisplay === 'bar' || p.volumeDisplay === 'none'
      ? p.volumeDisplay
      : 'bar'
  cache = {
    colorAlphaByVol: !!p.colorAlphaByVol,
    volumeDisplay: mode,
    showOsuObjects: p.showOsuObjects !== false,
  }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(cache))
  } catch {
    /* ignore */
  }
}

// 调试/自动化入口：端到端脚本要切换显示开关（生产构建同样保留，无副作用）
if (typeof window !== 'undefined') {
  ;(window as any).__displayPrefs = { get: getDisplayPrefs, set: setDisplayPrefs }
}
