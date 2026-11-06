/**
 * IMA ADPCM 立体声解码的回归测试（不依赖真实谱面文件）。
 *
 * 关键点：
 *  1. 块头 predictor 是第一个样本，不能漏；
 *  2. 立体声数据按「每声道 4 字节（8 nibble）一组、轮流存放」，不是每 nibble 轮流。
 * 这里用一个 blockAlign=16 的极小 WAV：ch0 全是 nibble 0（应保持 0），ch1 全是 nibble 7（应递增）。
 * 如果按 nibble 交替解，ch0 会混进 ch1 的 nibble 变成非 0。
 */
import { decodeImaAdpcmWav } from '../src/audio/wav'

function buildWav(): ArrayBuffer {
  const block = Buffer.alloc(16)
  // ch0 header: pred 0, step 0
  block.writeInt16LE(0, 0)
  block.writeUInt8(0, 2)
  // ch1 header: pred 1000, step 0
  block.writeInt16LE(1000, 4)
  block.writeUInt8(0, 6)
  // 数据：ch0 4 字节全 0x00；ch1 4 字节全 0x77
  block.fill(0x00, 8, 12)
  block.fill(0x77, 12, 16)

  const fmt = Buffer.alloc(8 + 20)
  fmt.write('fmt ', 0)
  fmt.writeUInt32LE(20, 4)
  fmt.writeUInt16LE(0x11, 8) // IMA ADPCM
  fmt.writeUInt16LE(2, 10)
  fmt.writeUInt32LE(44100, 12)
  fmt.writeUInt32LE(44100 * 2, 16) // byteRate（示意）
  fmt.writeUInt16LE(16, 20) // blockAlign
  fmt.writeUInt16LE(4, 22) // bits
  fmt.writeUInt16LE(2, 24) // cbSize
  fmt.writeUInt16LE(9, 26) // samplesPerBlock

  const data = Buffer.alloc(8 + block.length)
  data.write('data', 0)
  data.writeUInt32LE(block.length, 4)
  block.copy(data, 8)

  const body = Buffer.concat([Buffer.from('WAVE'), fmt, data])
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0)
  riff.writeUInt32LE(body.length, 4)
  const out = Buffer.concat([riff, body])
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
}

const d = decodeImaAdpcmWav(buildWav())
const fail = (m: string) => {
  console.log('FAIL ', m)
  process.exitCode = 1
}
const pass = (m: string) => console.log('PASS ', m)

if (!d) {
  fail('解码返回 null')
  process.exit(1)
}
pass(`frames=${d.frames} channels=${d.channels} rate=${d.sampleRate}`)
if (d.frames !== 9) fail(`每块应有 9 帧（8 nibble + 块头），实际 ${d.frames}`)
else pass('块头样本计入帧数（9 帧）')
if (Math.abs(d.data[0][0]) > 1e-9) fail(`ch0 第 0 帧应为 0，实际 ${d.data[0][0]}`)
else pass('块头 predictor 写入第 0 帧')
if (Math.abs(d.data[1][0] - 1000 / 32768) > 1e-6) fail(`ch1 第 0 帧应为 1000/32768，实际 ${d.data[1][0]}`)
else pass('ch1 predictor 正确')
const ch0non = d.data[0].some((x) => Math.abs(x) > 1e-9)
if (ch0non) fail('ch0 混入了 ch1 的 nibble（声道交错顺序错误）')
else pass('ch0 全 0，声道没有串')
const inc = d.data[1][1] > d.data[1][0] && d.data[1][2] > d.data[1][1]
if (!inc) fail(`ch1 应按 nibble 7 递增，实际 ${Array.from(d.data[1].slice(0, 4)).join(',')}`)
else pass('ch1 递增正常')
