/**
 * WAV 解码兜底：只处理 Chromium 的 `decodeAudioData` 不支持的 IMA ADPCM。
 *
 * osu! 谱面目录里不少老音效是 4-bit IMA ADPCM（WAVE_FORMAT_IMA_ADPCM = 0x0011）。
 * Web Audio 对它直接抛 EncodingError，表现就是「代码在、正文在，但点格子听不到」，
 * 自动加载也会静默少绑几个样本。这里自己解成 Float32，交给 engine 组 AudioBuffer。
 *
 * 块结构（每个 blockAlign 字节一块）：
 *   每声道 4 字节头（int16 predictor / uint8 stepIndex / uint8 reserved）
 *   之后按「低 nibble 先、声道轮流」排列的 4-bit 差值
 */

export interface DecodedWav {
  sampleRate: number
  channels: number
  /** 实际解出的每声道帧数 */
  frames: number
  data: Float32Array[]
}

const STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73,
  80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494,
  544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
  2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
  12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
]
const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8]

function ascii(view: DataView, at: number, len: number): string {
  let s = ''
  for (let i = 0; i < len && at + i < view.byteLength; i++) s += String.fromCharCode(view.getUint8(at + i))
  return s
}

/**
 * 解析 IMA ADPCM 的 WAV。不是这种格式（或文件不完整）返回 null，
 * 调用方继续走原本的 decodeAudioData 路径。
 */
export function decodeImaAdpcmWav(input: ArrayBuffer): DecodedWav | null {
  const view = new DataView(input)
  if (view.byteLength < 12) return null
  if (ascii(view, 0, 4) !== 'RIFF' || ascii(view, 8, 4) !== 'WAVE') return null

  let off = 12
  let format = 0
  let channels = 0
  let sampleRate = 0
  let blockAlign = 0
  let dataOff = -1
  let dataLen = 0
  while (off + 8 <= view.byteLength) {
    const id = ascii(view, off, 4)
    const size = view.getUint32(off + 4, true)
    const body = off + 8
    if (id === 'fmt ' && size >= 16) {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      blockAlign = view.getUint16(body + 12, true)
      // WAVE_FORMAT_EXTENSIBLE：真正的格式码在 SubFormat GUID 的头两字节
      if (format === 0xfffe && size >= 40) format = view.getUint16(body + 24, true)
    } else if (id === 'data') {
      dataOff = body
      dataLen = Math.min(size, view.byteLength - body)
    }
    off = body + size + (size & 1)
  }

  if (format !== 0x11 || !channels || !sampleRate || !blockAlign) return null
  const headerBytes = 4 * channels
  const payload = blockAlign - headerBytes
  if (payload <= 0) return null
  // 每块每声道样本数：nibble 数 ÷ 声道数 + 块头里的那个初始样本
  if ((payload * 2) % channels !== 0) return null
  const perBlock = (payload * 2) / channels + 1

  const blocks = Math.ceil(dataLen / blockAlign)
  if (!blocks) return null
  const total = blocks * perBlock
  const out: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(total))
  let written = 0

  for (let b = 0; b < blocks; b++) {
    const base = dataOff + b * blockAlign
    const end = Math.min(base + blockAlign, dataOff + dataLen)
    if (end - base < headerBytes + 1) break

    const pred = new Int16Array(channels)
    const step = new Uint8Array(channels)
    // 块头里的 predictor 就是本块的第一个样本，必须写进去；
    // 以前漏了它，又按 nibble 数当样本数，结果每块末尾多出一个 0 —— 试听时每 ~46ms 一声咔哒。
    for (let c = 0; c < channels; c++) {
      pred[c] = view.getInt16(base + c * 4, true)
      step[c] = Math.min(88, view.getUint8(base + c * 4 + 2))
      out[c][written] = pred[c] / 32768
    }

    let frame = 1
    let pos = base + headerBytes
    const put = (c: number, nib: number, at: number) => {
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
      out[c][at] = p / 32768
    }

    if (channels === 1) {
      // 单声道：低 nibble 在前、高 nibble 在后
      while (pos < end && frame < perBlock) {
        const byte = view.getUint8(pos++)
        for (let half = 0; half < 2 && frame < perBlock; half++) {
          put(0, half === 0 ? byte & 0x0f : byte >> 4, written + frame)
          frame++
        }
      }
    } else {
      /**
       * 立体声（以及多声道）IMA ADPCM 的数据不是「每 nibble 轮流声道」，
       * 而是**每声道 4 字节（8 个 nibble）一组、轮流存放**：
       * ch0 的 8 个样本 → ch1 的 8 个样本 → ch0 的下一组…
       * 以前按 nibble 交替解，左右声道会错位成噪声。
       */
      const group = 4
      while (pos + group * channels <= end && frame < perBlock) {
        for (let c = 0; c < channels; c++) {
          for (let i = 0; i < group; i++) {
            const byte = view.getUint8(pos + c * group + i)
            for (let half = 0; half < 2; half++) {
              const at = frame + i * 2 + half
              if (at >= perBlock) break
              put(c, half === 0 ? byte & 0x0f : byte >> 4, written + at)
            }
          }
        }
        pos += group * channels
        frame += group * 2
      }
    }
    written += Math.min(perBlock, frame)
  }

  if (!written) return null
  return {
    sampleRate,
    channels,
    frames: written,
    data: out.map((a) => a.subarray(0, written)),
  }
}
