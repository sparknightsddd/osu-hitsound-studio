#!/usr/bin/env python3
"""
从 SF2 音色库里导出若干音高的 wav（给 keysound 测试/试听用）。

用法：
  python scripts/sf2-to-wav.py <bank.sf2> <输出目录> [最低音] [最高音] [子目录]

音高写成 MIDI 编号（60 = C4），也可以写音名（C4 / H3，用项目里的 C H D I E F J G K A L B 记法）。
默认导出 C4~B5 一个八度多一点，文件名按 `<音名>.wav`（C4.wav / H4.wav …），
正好对上 [Define] 里的 `<loop(...)><int(...)>.wav` 模板；放在 `<输出目录>/piano/` 下。

只做最简单的处理：取 preset 0 第一个覆盖该音的 instrument zone，按根音重采样
（线性插值）、去掉前 8ms、截到 1.2 秒、峰值归一化到 0.7。够用来试听，不追求音质。
"""
import os
import struct
import sys
import wave

NOTE_CODES = 'CHDIEFJGKALB'
BLACK = 'HDIFJ'


def note_to_midi(name: str) -> int:
    name = name.strip()
    if name.lstrip('-').isdigit():
        return int(name)
    letter = name[0].upper()
    octave = int(name[1:])
    return (octave + 1) * 12 + NOTE_CODES.index(letter)


def midi_to_name(midi: int) -> str:
    semi = midi % 12
    octave = midi // 12 - 1
    return f'{NOTE_CODES[semi]}{octave}'


def riff_chunks(buf, start, end):
    i = start
    while i + 8 <= end:
        cid = buf[i:i + 4].decode('latin1')
        size = struct.unpack('<I', buf[i + 4:i + 8])[0]
        yield cid, i + 8, size
        i += 8 + size + (size & 1)


def find_list(buf, want: str):
    for cid, off, size in riff_chunks(buf, 12, len(buf)):
        if cid == 'LIST' and buf[off:off + 4].decode('latin1') == want:
            return off + 4, off + size
    raise SystemExit(f'找不到 LIST {want}')


def read_sf2(path: str):
    buf = open(path, 'rb').read()
    start, end = find_list(buf, 'pdta')
    chunks = {}
    for cid, off, size in riff_chunks(buf, start, end):
        chunks[cid] = (off, size)

    def recs(name, size):
        off, total = chunks[name]
        return [off + i * size for i in range(total // size)]

    def name_at(off):
        return buf[off:off + 20].split(b'\0')[0].decode('latin1', 'replace').strip()

    phdr = []
    for off in recs('phdr', 38):
        preset, bank, bag = struct.unpack('<HHH', buf[off + 20:off + 26])
        phdr.append({'name': name_at(off), 'preset': preset, 'bank': bank, 'bag': bag})

    pbag = [struct.unpack('<HH', buf[o:o + 4]) for o in recs('pbag', 4)]
    pgen = [struct.unpack('<HH', buf[o:o + 4]) for o in recs('pgen', 4)]
    inst = []
    for off in recs('inst', 22):
        inst.append({'name': name_at(off), 'bag': struct.unpack('<H', buf[off + 20:off + 22])[0]})
    ibag = [struct.unpack('<HH', buf[o:o + 4]) for o in recs('ibag', 4)]
    igen = [struct.unpack('<HH', buf[o:o + 4]) for o in recs('igen', 4)]

    shdr = []
    for off in recs('shdr', 46):
        s, e, sl, el, rate, root, corr, link, typ = struct.unpack('<IIIIIBbHH', buf[off + 20:off + 46])
        shdr.append({
            'name': name_at(off), 'start': s, 'end': e, 'loopStart': sl, 'loopEnd': el,
            'rate': rate, 'root': root, 'corr': corr, 'type': typ,
        })

    smpl_off, smpl_size = 0, 0
    sd_start, sd_end = find_list(buf, 'sdta')
    for cid, off, size in riff_chunks(buf, sd_start, sd_end):
        if cid == 'smpl':
            smpl_off, smpl_size = off, size
    smpl = buf[smpl_off:smpl_off + smpl_size]
    return {'buf': buf, 'phdr': phdr, 'pbag': pbag, 'pgen': pgen, 'inst': inst,
            'ibag': ibag, 'igen': igen, 'shdr': shdr, 'smpl': smpl}


def gens(sf2, table, bags, index, is_inst):
    """返回某个 zone 的 (oper, amount) 列表；table 是 pgen 或 igen"""
    lo = bags[index][0]
    hi = bags[index + 1][0]
    out = []
    for k in range(lo, hi):
        oper, amount = table[k]
        out.append((oper, amount))
    return out


def preset_zones(sf2, index):
    p = sf2['phdr'][index]
    out = []
    for z in range(p['bag'], sf2['phdr'][index + 1]['bag']):
        for oper, amount in gens(sf2, sf2['pgen'], sf2['pbag'], z, False):
            if oper == 41:  # instrument
                out.append(amount)
    return out


def inst_zones(sf2, inst_id):
    """每条：{lo, hi, sample, root, coarse, fine, gain}"""
    out = []
    for z in range(sf2['inst'][inst_id]['bag'], sf2['inst'][inst_id + 1]['bag']):
        lo, hi, sample, root, coarse, fine, gain = 0, 127, None, None, 0, 0, 0
        for oper, amount in gens(sf2, sf2['igen'], sf2['ibag'], z, True):
            if oper == 43:  # keyRange
                lo, hi = amount & 0xFF, (amount >> 8) & 0xFF
            elif oper == 53:
                sample = amount
            elif oper == 58:
                root = amount
            elif oper == 51:
                fine = struct.unpack('<h', struct.pack('<H', amount))[0]
            elif oper == 52:
                coarse = struct.unpack('<h', struct.pack('<H', amount))[0]
            elif oper == 48:
                gain = struct.unpack('<h', struct.pack('<H', amount))[0] / 100.0
        if sample is not None:
            out.append({'lo': lo, 'hi': hi, 'sample': sample, 'root': root, 'coarse': coarse,
                        'fine': fine, 'gain': gain})
    return out


def render(sf2, zone, midi, max_sec=1.2, out_rate=44100):
    s = sf2['shdr'][zone['sample']]
    root = zone['root'] if zone['root'] is not None else s['root']
    if s['end'] <= s['start']:
        raise SystemExit('空样本')
    ratio = 2 ** ((midi - root + zone['coarse'] + zone['fine'] / 100.0) / 12) * (s['rate'] / out_rate)
    n_in = s['end'] - s['start']
    n_out = min(int(max_sec * out_rate), max(1, int(n_in / ratio)))
    src = sf2['smpl']
    base = s['start'] * 2
    gain = 10 ** (zone['gain'] / 20.0)

    frames = bytearray()
    peak = 1
    vals = []
    for i in range(n_out):
        pos = i * ratio
        idx = int(pos)
        frac = pos - idx
        if idx + 1 >= n_in:
            break
        a = struct.unpack_from('<h', src, base + idx * 2)[0]
        b = struct.unpack_from('<h', src, base + (idx + 1) * 2)[0]
        v = int((a + (b - a) * frac) * gain)
        vals.append(v)
        peak = max(peak, abs(v))
    # 前 8ms 淡入，末尾 60ms 淡出，避免爆音
    fade_in = int(0.008 * out_rate)
    fade_out = int(0.06 * out_rate)
    scale = 0.7 * 32767 / peak if peak > 0 else 1
    n = len(vals)
    for i, v in enumerate(vals):
        x = v * scale
        if i < fade_in:
            x *= i / fade_in
        left = n - i
        if left < fade_out:
            x *= left / fade_out
        frames += struct.pack('<h', max(-32768, min(32767, int(x))))
    return bytes(frames), out_rate


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(2)
    sf2_path, out_dir = sys.argv[1], sys.argv[2]
    low = note_to_midi(sys.argv[3]) if len(sys.argv) > 3 else 60
    high = note_to_midi(sys.argv[4]) if len(sys.argv) > 4 else 83
    sub = sys.argv[5] if len(sys.argv) > 5 else 'piano'

    sf2 = read_sf2(sf2_path)
    piano = next((i for i, p in enumerate(sf2['phdr'][:-1]) if 'piano' in p['name'].lower()), 0)
    inst_ids = preset_zones(sf2, piano)
    if not inst_ids:
        raise SystemExit('preset 没有 instrument')
    zones = []
    for iid in inst_ids:
        zones.extend(inst_zones(sf2, iid))
    if not zones:
        raise SystemExit('instrument 没有 zone')

    dest = os.path.join(out_dir, sub)
    os.makedirs(dest, exist_ok=True)
    made = 0
    for midi in range(low, high + 1):
        zone = next((z for z in zones if z['lo'] <= midi <= z['hi']), None)
        if not zone:
            zone = min(zones, key=lambda z: min(abs(z['lo'] - midi), abs(z['hi'] - midi)))
        data, rate = render(sf2, zone, midi)
        name = midi_to_name(midi)
        with wave.open(os.path.join(dest, f'{name}.wav'), 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(data)
        made += 1
    print(f'{made} 个音高 → {dest}')


if __name__ == '__main__':
    main()
