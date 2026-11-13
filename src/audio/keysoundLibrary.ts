/**
 * 把 .sf2/.sf3/.sfz/单一音频载入成「乐器 → 每个音高的样本 + 变调」。
 *
 * 读取文件的方式由调用方给（Electron 直接读磁盘，浏览器从 File 列表里找），
 * 这里只负责解析和往引擎里塞 buffer。
 */
import type { HitsoundDef } from '../core/types'
import { engine } from './engine'
import type { KeyLayoutEntry } from './keyLayout'
import { keyZones, parseSoundFont, pickPreset, pcmToFloat, sampleBytes } from './soundfont'
import { parseSfz } from './sfz'

export interface LibraryReader {
  /** 主文件（音色库 / sfz / 单一音频）的字节 */
  readMain: () => Promise<ArrayBuffer | null>
  /** sfz 里的 sample= 相对路径 → 交给 readPath 的完整标识 */
  resolve: (rel: string) => string
  readPath: (path: string) => Promise<ArrayBuffer | null>
}

export interface LibraryLoadResult {
  ok: boolean
  /** 一行给日志/界面看的说明 */
  note: string
}

const MAX_RATE = 16
const MIN_RATE = 1 / 16

function rateFor(key: number, root: number, tuneCents: number): number {
  const semis = key - root + tuneCents / 100
  return Math.max(MIN_RATE, Math.min(MAX_RATE, Math.pow(2, semis / 12)))
}

/** centibel → 线性增益 */
function gainOf(attenuation: number): number {
  const db = -attenuation / 10
  return Math.max(0, Math.min(4, Math.pow(10, db / 20)))
}

export async function loadKeysoundLibrary(
  instrument: string,
  def: HitsoundDef,
  reader: LibraryReader,
): Promise<LibraryLoadResult> {
  const kind = def.library || 'sample'
  const keys = def.keys
  let main: ArrayBuffer | null = null
  try {
    main = await reader.readMain()
  } catch {
    main = null
  }
  if (!main) return { ok: false, note: `乐器 ${instrument} ✗ 读不到音色库文件` }

  if (kind === 'sf2' || kind === 'sf3') {
    let sf
    try {
      sf = parseSoundFont(main, kind)
    } catch (e) {
      return { ok: false, note: `乐器 ${instrument} ✗ ${kind.toUpperCase()} 解析失败：${e instanceof Error ? e.message : String(e)}` }
    }
    const picked = pickPreset(sf, {
      bank: keys?.bank ?? 0,
      preset: keys?.preset ?? 0,
      program: keys?.program ?? 0,
      percussion: !!keys?.percussion,
    })
    if (!picked.preset) return { ok: false, note: `乐器 ${instrument} ✗ ${picked.warning || '没有可用 preset'}` }
    const zones = keyZones(picked.preset)
    const decoded = new Map<number, string>()
    for (const zone of new Set(zones.values())) {
      const sample = sf.samples[zone.sampleIndex]
      if (!sample) continue
      const bytes = sampleBytes(sf, sample)
      if (!bytes || !bytes.length) continue
      const name = `sf:${instrument}:${zone.sampleIndex}`
      try {
        if (kind === 'sf3') {
          const copy = bytes.slice()
          engine.bindBuffer(name, await engine.decodeBuffer(copy.buffer))
        } else {
          engine.bindBuffer(name, engine.pcmBuffer([pcmToFloat(bytes)], sample.sampleRate))
        }
        decoded.set(zone.sampleIndex, name)
      } catch {
        /* 单个样本解码失败就跳过，剩下的音高还能用 */
      }
    }
    const layout = new Map<number, KeyLayoutEntry>()
    for (const [key, zone] of zones) {
      const buffer = decoded.get(zone.sampleIndex)
      if (!buffer) continue
      layout.set(key, {
        buffer,
        // 乐器级 tune 由 engine.setKeyTune 统一叠加，这里只算 zone 自己的粗/细调
        rate: rateFor(key, zone.rootKey, zone.coarseTune * 100 + zone.fineTune),
        gain: gainOf(zone.attenuation),
      })
    }
    engine.setKeyLayout(instrument, layout)
    const warn = picked.warning ? `（${picked.warning}）` : ''
    return {
      ok: layout.size > 0,
      note:
        layout.size > 0
          ? `乐器 ${instrument} ✓ ${kind.toUpperCase()} "${picked.preset.name}" bank ${picked.preset.bank} / program ${picked.preset.program}，${zones.size} 个音高${warn}`
          : `乐器 ${instrument} ✗ preset "${picked.preset.name}" 没有可解码的样本`,
    }
  }

  if (kind === 'sfz') {
    let parsed
    try {
      parsed = parseSfz(new TextDecoder().decode(main))
    } catch (e) {
      return { ok: false, note: `乐器 ${instrument} ✗ SFZ 解析失败：${e instanceof Error ? e.message : String(e)}` }
    }
    if (!parsed.regions.length) {
      return { ok: false, note: `乐器 ${instrument} ✗ ${parsed.errors[0] || 'SFZ 里没有 region'}` }
    }
    const layout = new Map<number, KeyLayoutEntry>()
    const cache = new Map<string, string>()
    let failed = 0
    for (let i = 0; i < parsed.regions.length; i++) {
      const r = parsed.regions[i]
      let name = cache.get(r.sample)
      if (!name) {
        const path = reader.resolve(r.sample)
        const bytes = await reader.readPath(path)
        if (!bytes) {
          failed++
          continue
        }
        name = `sfz:${instrument}:${i}`
        try {
          engine.bindBuffer(name, await engine.decodeBuffer(bytes))
        } catch {
          failed++
          continue
        }
        cache.set(r.sample, name)
      }
      for (let key = r.keyLow; key <= r.keyHigh; key++) {
        if (layout.has(key)) continue
        layout.set(key, {
          buffer: name,
          rate: rateFor(key, r.root, r.tune),
          gain: r.gain,
        })
      }
    }
    engine.setKeyLayout(instrument, layout)
    if (!layout.size) return { ok: false, note: `乐器 ${instrument} ✗ SFZ 的样本都没读出来` }
    return {
      ok: true,
      note: `乐器 ${instrument} ✓ SFZ，${parsed.regions.length} 个 region，${layout.size} 个音高${failed ? `（${failed} 个样本失败）` : ''}`,
    }
  }

  // 单一音频：整段样本按 C4 为根音变调
  try {
    const buffer = await engine.decodeBuffer(main)
    const name = `kssingle:${instrument}`
    engine.bindBuffer(name, buffer)
    const layout = new Map<number, KeyLayoutEntry>()
    for (let key = 0; key <= 127; key++) {
      layout.set(key, { buffer: name, rate: rateFor(key, 60, 0), gain: 1 })
    }
    engine.setKeyLayout(instrument, layout)
    return { ok: true, note: `乐器 ${instrument} ✓ 单一音频（以 C4 为根音变调）` }
  } catch (e) {
    return { ok: false, note: `乐器 ${instrument} ✗ 解码失败：${e instanceof Error ? e.message : String(e)}` }
  }
}
