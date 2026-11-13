/**
 * 导出音效时用到的 WAV 工具（主进程，CommonJS）。
 *
 * 只做三件事：读 WAV（PCM / float / IMA ADPCM）、按 Audacity 的方式相加混音、写 16-bit PCM。
 * 没有引第三方解码器 —— osu 音效绝大多数就是 WAV，遇到 mp3/ogg 直接报错让用户自己处理。
 */
const fs = require('fs')

function ascii(buf, at, len) {
  return buf.toString('ascii', at, at + len)
}

const STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73,
  80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494,
  544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
  2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
  12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
]
const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8]

function decodeAdpcm(buf, view, fmt, dataOff, dataLen) {
  const channels = fmt.channels
  const blockAlign = fmt.blockAlign
  const headerBytes = 4 * channels
  const payload = blockAlign - headerBytes
  if (payload <= 0 || (payload * 2) % channels !== 0) return null
  const perBlock = (payload * 2) / channels + 1
  const blocks = Math.ceil(dataLen / blockAlign)
  const total = blocks * perBlock
  const out = []
  for (let c = 0; c < channels; c++) out.push(new Float32Array(total))
  let written = 0
  for (let b = 0; b < blocks; b++) {
    const base = dataOff + b * blockAlign
    const end = Math.min(base + blockAlign, dataOff + dataLen)
    if (end - base < headerBytes + 1) break
    const pred = new Int16Array(channels)
    const step = new Uint8Array(channels)
    for (let c = 0; c < channels; c++) {
      pred[c] = view.getInt16(base + c * 4, true)
      step[c] = view.getUint8(base + c * 4 + 2)
    }
    let c = 0
    let produced = 0
    let pos = base + headerBytes
    while (pos < end && produced < perBlock) {
      const byte = view.getUint8(pos++)
      for (let half = 0; half < 2 && produced < perBlock; half++) {
        const nib = half === 0 ? byte & 0x0f : byte >> 4
        const s = STEP_TABLE[step[c]]
        let diff = s >> 3
        if (nib & 1) diff += s >> 2
        if (nib & 2) diff += s >> 1
        if (nib & 4) diff += s
        let p = nib & 8 ? pred[c] - diff : pred[c] + diff
        if (p > 32767) p = 32767
        else if (p < -32768) p = -32768
        let si = step[c] + INDEX_TABLE[nib]
        if (si < 0) si = 0
        else if (si > 88) si = 88
        pred[c] = p
        step[c] = si
        out[c][written + produced] = p / 32768
        c++
        if (c === channels) {
          c = 0
          produced++
        }
      }
    }
    written += produced
  }
  if (!written) return null
  return { sampleRate: fmt.sampleRate, channels, data: out.map((a) => a.subarray(0, written)) }
}

/** 读 WAV，返回 { sampleRate, channels, data: Float32Array[] } */
function readWav(file) {
  const buf = fs.readFileSync(file)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (buf.length < 12) return null
  if (ascii(buf, 0, 4) !== 'RIFF' || ascii(buf, 8, 4) !== 'WAVE') return null

  let off = 12
  let fmt = null
  let dataOff = -1
  let dataLen = 0
  let meta = null
  while (off + 8 <= buf.length) {
    const id = ascii(buf, off, 4)
    const size = view.getUint32(off + 4, true)
    const body = off + 8
    if (id === 'fmt ' && size >= 16) {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bits: view.getUint16(body + 14, true),
      }
      if (fmt.format === 0xfffe && size >= 40) fmt.format = view.getUint16(body + 24, true)
    } else if (id === 'data') {
      dataOff = body
      dataLen = Math.min(size, buf.length - body)
    } else if (id === 'HSSM') {
      // 混音时写进来的来源信息（JSON），重新导入时靠它拆回原来的音效
      try {
        meta = JSON.parse(buf.toString('utf8', body, body + size))
      } catch {
        meta = null
      }
    }
    off = body + size + (size & 1)
  }
  if (!fmt || dataOff < 0) return null

  const withMeta = (w) => (w ? { ...w, meta } : null)
  if (fmt.format === 0x11) return withMeta(decodeAdpcm(buf, view, fmt, dataOff, dataLen))

  const ch = fmt.channels
  if (!ch) return null
  let frameBytes = 0
  if (fmt.format === 1) frameBytes = (fmt.bits / 8) * ch
  else if (fmt.format === 3) frameBytes = (fmt.bits / 8) * ch
  if (!frameBytes || !Number.isInteger(frameBytes)) return null

  const frames = Math.floor(dataLen / frameBytes)
  const data = []
  for (let c = 0; c < ch; c++) data.push(new Float32Array(frames))

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const at = dataOff + i * frameBytes + c * (frameBytes / ch)
      let v = 0
      if (fmt.format === 3) {
        v = fmt.bits === 64 ? view.getFloat64(at, true) : view.getFloat32(at, true)
      } else if (fmt.bits === 8) {
        v = (view.getUint8(at) - 128) / 128
      } else if (fmt.bits === 16) {
        v = view.getInt16(at, true) / 32768
      } else if (fmt.bits === 24) {
        const b0 = view.getUint8(at)
        const b1 = view.getUint8(at + 1)
        const b2 = view.getInt8(at + 2)
        v = ((b2 << 16) | (b1 << 8) | b0) / 8388608
      } else if (fmt.bits === 32) {
        v = view.getInt32(at, true) / 2147483648
      }
      data[c][i] = v
    }
  }
  return { sampleRate: fmt.sampleRate, channels: ch, data, meta }
}

/** 线性重采样到指定采样率（音效很短，够用） */
function resample(src, sampleRate) {
  if (src.sampleRate === sampleRate) return src
  const ratio = sampleRate / src.sampleRate
  const frames = Math.max(1, Math.round(src.data[0].length * ratio))
  const out = []
  for (let c = 0; c < src.channels; c++) {
    const from = src.data[c]
    const to = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      const pos = i / ratio
      const i0 = Math.floor(pos)
      const i1 = Math.min(from.length - 1, i0 + 1)
      const t = pos - i0
      to[i] = (from[i0] || 0) * (1 - t) + (from[i1] || 0) * t
    }
    out.push(to)
  }
  return { sampleRate, channels: src.channels, data: out }
}

/**
 * 混音：统一采样率/声道，逐样本相加，超出 ±1 直接截断（和 Audacity 的 Mix and Render 一致）。
 * @param delays 每个源的延迟（毫秒），缺省 0；successor 用它做「A -250ms- B」
 */
function mixWavs(list, delays) {
  const valid = list.filter(Boolean)
  if (!valid.length) return null
  const sampleRate = Math.max(...valid.map((w) => w.sampleRate))
  const channels = Math.max(...valid.map((w) => w.channels))
  const parts = valid.map((w) => resample(w, sampleRate))
  const offsets = parts.map((_, i) => {
    const ms = (delays && delays[i]) || 0
    return Math.max(0, Math.round((ms / 1000) * sampleRate))
  })
  const frames = Math.max(...parts.map((p, i) => p.data[0].length + offsets[i]))
  const data = []
  for (let c = 0; c < channels; c++) data.push(new Float32Array(frames))
  for (let j = 0; j < parts.length; j++) {
    const p = parts[j]
    const off = offsets[j]
    for (let c = 0; c < channels; c++) {
      // 单声道素材铺到每个声道；多声道裁剪到目标声道数
      const src = p.data[Math.min(c, p.channels - 1)]
      for (let i = 0; i < src.length; i++) data[c][off + i] += src[i] || 0
    }
  }
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < frames; i++) {
      const v = data[c][i]
      data[c][i] = v > 1 ? 1 : v < -1 ? -1 : v
    }
  }
  return { sampleRate, channels, data, frames }
}

/**
 * 编码成 16-bit PCM WAV 的 Buffer。
 * @param meta 可选，写进 data 之后的 HSSM 块（JSON），记录混音来源
 */
function encodeWav16(mixed, meta) {
  const { sampleRate, channels, data, frames } = mixed
  const bytes = frames * channels * 2
  const metaBuf = meta ? Buffer.from(JSON.stringify(meta), 'utf8') : null
  const metaSize = metaBuf ? 8 + metaBuf.length + (metaBuf.length % 2) : 0
  const buf = Buffer.alloc(44 + bytes + metaSize)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + bytes + metaSize, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * channels * 2, 28)
  buf.writeUInt16LE(channels * 2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(bytes, 40)
  let at = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]))
      buf.writeInt16LE(Math.round(v * 32767), at)
      at += 2
    }
  }
  if (metaBuf) {
    let at2 = 44 + bytes
    buf.write('HSSM', at2, 'ascii')
    buf.writeUInt32LE(metaBuf.length, at2 + 4)
    metaBuf.copy(buf, at2 + 8)
  }
  return buf
}

/** 写 16-bit PCM WAV；混音结果要用于「和已有文件比对」时直接用 encodeWav16 */
function writeWav16(file, mixed, meta) {
  fs.writeFileSync(file, encodeWav16(mixed, meta))
  return true
}

/**
 * 读若干文件并混成一个 wav（不落盘）。
 * 返回 buffer，方便导出时先和目录里已有文件比对，再决定跳过还是报冲突。
 */
function mixBuffers(sources, meta, delays) {
  const errors = []
  const waves = []
  for (const p of sources) {
    try {
      const w = readWav(p)
      if (!w) {
        errors.push(`不是可解析的 WAV：${p}`)
        continue
      }
      waves.push(w)
    } catch (err) {
      errors.push(`读取失败：${p}（${String(err)}）`)
    }
  }
  if (!waves.length) return { ok: false, errors }
  const mixed = mixWavs(waves, delays)
  if (!mixed) return { ok: false, errors }
  return { ok: true, buffer: encodeWav16(mixed, meta), errors }
}

/** 读若干文件并混成一个 wav；读不了的文件会被跳过并记在 errors 里 */
function mixFilesTo(sources, outPath, meta, delays) {
  const r = mixBuffers(sources, meta, delays)
  if (!r.ok) return { ok: false, errors: r.errors }
  fs.writeFileSync(outPath, r.buffer)
  return { ok: true, errors: r.errors }
}

module.exports = { readWav, mixWavs, encodeWav16, writeWav16, mixBuffers, mixFilesTo }
