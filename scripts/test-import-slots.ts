/**
 * 导入时 [Define] 的槽位：文件名自带槽位信息（drum-hitclap.wav）就写成固定的，
 * 同一个文件被当成多个槽位用时才退回 custom。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractOsuSounds, slotFromFileName } from '../src/core/osuSounds'
import { renderOsuSoundsHs } from '../src/core/osuToHs'

let bad = 0
function ok(cond: boolean, name: string) {
  if (!cond) {
    bad++
    console.log(`FAIL ${name}`)
  } else console.log(`ok   ${name}`)
}

/** 三段红线：0 起 soft，60000 起 drum，120000 起 normal */
const OSU = `osu file format v14

[General]
AudioFilename: audio.mp3
SampleSet: Soft

[Metadata]
Title:slot
Artist:tester
Creator:tester
Version:test

[TimingPoints]
0,500,4,2,0,60,1,0
60000,500,4,3,1,70,1,0
120000,500,4,1,1,80,1,0

[HitObjects]
256,192,1000,1,0,0:0:0:0:
256,192,2000,1,2,0:0:0:0:
256,192,3000,1,8,0:0:0:0:
256,192,61000,1,10,0:0:0:0:
256,192,122000,1,8,0:0:0:0:
`

function envFor(dir: string, hash: (rel: string) => string = (rel) => 'h:' + rel) {
  return {
    dir,
    fileName: 'slots.osu',
    fileExists: async (d: string, rel: string) => existsSync(join(d, rel)),
    hashFile: async (_d: string, rel: string) => hash(rel),
    audioDurationMs: async () => 0,
  }
}

function defineOf(res: Awaited<ReturnType<typeof extractOsuSounds>>): string {
  return renderOsuSoundsHs(res).text.split('[Define]')[1].split('[Timing]')[0]
}

async function main() {
  // 1) 文件名 → 槽位
  ok(slotFromFileName('drum-hitclap.wav') === 'drum-hitclap', 'drum-hitclap.wav → drum-hitclap')
  ok(slotFromFileName('soft-hitnormal8.wav') === 'soft-hitnormal', '带编号也认：soft-hitnormal8.wav')
  ok(slotFromFileName('E:/x/Normal-HitFinish.ogg') === 'normal-hitfinish', '路径 + 大写 + ogg')
  ok(slotFromFileName('my-soft-hitclap-remix.wav') === '', '非标准命名不硬猜')
  ok(slotFromFileName('') === '', '空文件名')

  // 2) 导入后的 [Define]：文件名有槽位就写死
  {
    const dir = mkdtempSync(join(tmpdir(), 'hsslots-'))
    for (const f of ['soft-hitwhistle.wav', 'drum-hitwhistle.wav', 'normal-hitclap.wav']) {
      writeFileSync(join(dir, f), 'x')
    }
    const res = await extractOsuSounds(OSU, envFor(dir) as never)
    const define = defineOf(res)
    ok(/hitsound soft-hitwhistle \w+ = "soft-hitwhistle\.wav"/.test(define), 'soft 区域写成 soft-hitwhistle')
    ok(/hitsound drum-hitwhistle \w+ = "drum-hitwhistle\.wav"/.test(define), 'drum 区域写成 drum-hitwhistle')
    ok(/hitsound normal-hitclap \w+ = "normal-hitclap\.wav"/.test(define), 'clap 写成 normal-hitclap')
    ok(!/hitsound custom \w+ = "(soft|drum)-hitwhistle/.test(define), '这些都不再是 custom')
    rmSync(dir, { recursive: true, force: true })
  }

  // 3) 同一个文件被两个槽位共用（内容相同）→ 只能 custom
  {
    const dir = mkdtempSync(join(tmpdir(), 'hsslots2-'))
    writeFileSync(join(dir, 'soft-hitclap.wav'), 'same')
    writeFileSync(join(dir, 'drum-hitclap.wav'), 'same')
    const res = await extractOsuSounds(OSU, envFor(dir, () => 'same-hash') as never)
    const define = defineOf(res)
    ok(/hitsound custom \w+ = "soft-hitclap\.wav"/.test(define), `共用文件退回 custom：\n${define.trim()}`)
    ok(!/hitsound (soft|drum)-hitclap/.test(define), '不会只写成其中一个槽位')
    rmSync(dir, { recursive: true, force: true })
  }

  console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
  if (bad) process.exit(1)
}
main()
