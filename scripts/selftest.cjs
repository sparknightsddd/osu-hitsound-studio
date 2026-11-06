"use strict";

// src/core/measures.ts
var MAX_MEASURES = 2e4;
var MeasureGrid = class {
  list = [];
  cursor;
  timing;
  warned = false;
  warnedReset = false;
  diags;
  constructor(timing, diags) {
    this.diags = diags;
    this.timing = [...timing].sort((a, b) => a.offset - b.offset);
    const first = this.timing[0];
    this.cursor = first ? first.offset + (first.shift || 0) : 0;
  }
  active(t) {
    let p;
    for (const tp of this.timing) {
      if (tp.offset <= t + 1e-9) p = tp;
      else break;
    }
    return p;
  }
  nextAfter(t) {
    return this.timing.find((tp) => tp.offset > t + 1e-9);
  }
  get(i) {
    while (this.list.length <= i && this.list.length < MAX_MEASURES) {
      this.list.push(this.build(this.list.length));
    }
    if (i >= this.list.length) {
      return { index: i, start: this.cursor, end: this.cursor + 2e3, beatLength: 500, meter: 4 };
    }
    return this.list[i];
  }
  get length() {
    return this.list.length;
  }
  /**
   * 某个时间点落在第几个小节（0 起）。
   * 网格是懒生成的，这里会一路生成到覆盖该时间为止。
   */
  indexAt(time) {
    if (!Number.isFinite(time)) return 0;
    if (this.list.length === 0) this.get(0);
    if (time < this.list[0].start) return 0;
    let i = 0;
    while (i < MAX_MEASURES) {
      const m = this.get(i);
      if (time < m.end) return i;
      i++;
    }
    return i;
  }
  snapshot() {
    return this.list.slice();
  }
  build(index) {
    const p = this.active(this.cursor);
    const start = this.cursor;
    const meter = p && p.meter > 0 ? p.meter : 4;
    const bl2 = p && p.beatLength > 0 ? p.beatLength : 500;
    if ((!p || p.beatLength <= 0) && !this.warned) {
      this.warned = true;
      this.diags.push({
        from: p ? p.from : 0,
        to: p ? p.to : 0,
        severity: "warning",
        message: "Timing \u7F3A\u5C11\u6709\u6548\u7684\u6BCF\u62CD\u6BEB\u79D2\u6570\uFF0C\u5DF2\u6309 120 BPM / 4 \u62CD \u515C\u5E95\u5904\u7406",
        code: "timing-fallback"
      });
    }
    const naturalEnd = start + meter * bl2;
    let end = naturalEnd;
    let segments;
    const next = this.nextAfter(start);
    if (next) {
      const changeAt = next.offset + (next.shift || 0);
      if (next.resetMode !== 0) {
        if (changeAt < naturalEnd - 1e-9 && changeAt > start + 1e-9) {
          end = changeAt;
        }
      } else if (changeAt < naturalEnd - 1e-9) {
        const newBl = next.beatLength > 0 ? next.beatLength : bl2;
        let r = next.resetBeats > 0 ? next.resetBeats : (changeAt - start) / bl2;
        r = Math.max(0, Math.min(meter, r));
        const mid = start + r * bl2;
        end = mid + (meter - r) * newBl;
        if (r > 1e-9 && r < meter - 1e-9) {
          segments = [
            { start, end: mid, beatLength: bl2, beats: r },
            { start: mid, end, beatLength: newBl, beats: meter - r }
          ];
        }
        if (next.resetBeats <= 0 && !next.resetBeatsSet && !this.warnedReset) {
          this.warnedReset = true;
          this.diags.push({
            from: next.from,
            to: next.to,
            severity: "info",
            message: "\u8BE5 Timing \u672A\u5199 resetBeats\uFF0C\u5DF2\u6309\u53D8\u66F4\u70B9\u6240\u5728\u65F6\u95F4\u63A8\u7B97\u5B83\u843D\u5728\u5C0F\u8282\u7B2C " + r.toFixed(2) + " \u62CD",
            code: "timing-resetbeats"
          });
        }
      }
    }
    if (!(end > start)) end = start + Math.max(1, meter * bl2);
    this.cursor = end;
    const info = { index, start, end, beatLength: bl2, meter };
    if (segments) info.segments = segments;
    return info;
  }
};
function measureBeatTimes(m) {
  const out = [];
  if (!m.segments || !m.segments.length) {
    const bl2 = m.beatLength > 0 ? m.beatLength : 500;
    for (let b = 0; b < m.meter; b++) out.push(m.start + b * bl2);
    return out;
  }
  for (const seg of m.segments) {
    const bl2 = seg.beatLength > 0 ? seg.beatLength : 500;
    for (let b = 0; b < seg.beats - 1e-9; b++) out.push(seg.start + b * bl2);
  }
  return out;
}
function measureTicks(m, div) {
  const out = [];
  const d = Math.max(1, Math.floor(div));
  if (!m.segments || !m.segments.length) {
    const bl2 = m.beatLength > 0 ? m.beatLength : 500;
    for (let b = 0; b < m.meter; b++) {
      const bs = m.start + b * bl2;
      for (let i = 0; i < d; i++) out.push(bs + i * bl2 / d);
    }
    return out;
  }
  for (const seg of m.segments) {
    const bl2 = seg.beatLength > 0 ? seg.beatLength : 500;
    for (let b = 0; b < seg.beats - 1e-9; b++) {
      const bs = seg.start + b * bl2;
      for (let i = 0; i < d; i++) {
        const t = bs + i * bl2 / d;
        if (t < seg.end - 1e-6) out.push(t);
      }
    }
  }
  return out;
}
function beatAt(m, t) {
  if (m.segments && m.segments.length) {
    let beats = 0;
    for (const seg of m.segments) {
      if (t < seg.end - 1e-9) {
        return beats + (t - seg.start) / (seg.beatLength > 0 ? seg.beatLength : 500);
      }
      beats += seg.beats;
    }
    return beats;
  }
  return (t - m.start) / (m.beatLength > 0 ? m.beatLength : 500);
}

// src/core/pitch.ts
var NOTE_CODES = "CHDIEFJGKALB";
var BLACK = /* @__PURE__ */ new Set([1, 3, 6, 8, 10]);
var PIANO_LOW = 21;
var PIANO_HIGH = 108;
var DEFAULT_OCTAVE = 4;
function letterToSemi(letter) {
  if (letter.length !== 1) return null;
  const i = NOTE_CODES.indexOf(letter);
  return i < 0 ? null : i;
}
function semiToLetter(semi) {
  return NOTE_CODES[(semi % 12 + 12) % 12];
}
function midiOf(letter, octave) {
  const s = letterToSemi(letter);
  if (s === null) return null;
  return (octave + 1) * 12 + s;
}
function nameToMidi(name) {
  const m = /^([A-L])(-?\d+)$/.exec(name.trim());
  if (!m) return null;
  return midiOf(m[1], Number(m[2]));
}
function midiToName(midi) {
  const m = Math.round(midi);
  const semi = (m % 12 + 12) % 12;
  const oct = Math.floor(m / 12) - 1;
  return `${semiToLetter(semi)}${oct}`;
}
function freqOf(midi, tuneCents = 0, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69 + tuneCents / 100) / 12);
}
function isBlackKey(midi) {
  return BLACK.has((Math.round(midi) % 12 + 12) % 12);
}
function clampToRange(midi, low = PIANO_LOW, high = PIANO_HIGH) {
  let m = midi;
  while (m < low) m += 12;
  while (m > high) m -= 12;
  return m;
}
function newPitchState() {
  return { prev: null, octave: null };
}
function resolvePitch(letter, st, opts = {}) {
  const semi = letterToSemi(letter);
  if (semi === null) return null;
  const absOct = opts.absOct !== void 0 && opts.absOct !== null ? opts.absOct : null;
  const rel = opts.rel ?? 0;
  let out;
  if (absOct !== null) {
    out = clampToRange((absOct + 1) * 12 + semi);
    st.octave = absOct;
  } else if (st.prev === null) {
    const oct = DEFAULT_OCTAVE + rel;
    out = clampToRange((oct + 1) * 12 + semi);
  } else if (rel !== 0) {
    const lo = rel > 0 ? (rel - 1) * 12 + 1 : rel * 12;
    const hi = rel > 0 ? rel * 12 : (rel + 1) * 12 - 1;
    out = pickInRange(semi, st.prev, lo, hi);
  } else {
    out = pickInRange(semi, st.prev, -6, 5);
  }
  st.prev = out;
  return out;
}
function pickInRange(semi, prev, lo, hi) {
  let best = null;
  let bestDiff = Infinity;
  let fallback = null;
  let fallbackDiff = Infinity;
  for (let oct = -1; oct <= 9; oct++) {
    const m = (oct + 1) * 12 + semi;
    const d = m - prev;
    if (Math.abs(d) < fallbackDiff) {
      fallbackDiff = Math.abs(d);
      fallback = m;
    }
    if (d >= lo && d <= hi && Math.abs(d) < bestDiff) {
      bestDiff = Math.abs(d);
      best = m;
    }
  }
  const picked = best !== null ? best : fallback !== null ? fallback : (DEFAULT_OCTAVE + 1) * 12 + semi;
  return clampToRange(picked);
}

// src/core/keysound.ts
function readParen(s, start) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return { inner: s.slice(start + 1, i), end: i };
    }
  }
  return null;
}
function splitTemplateArgs(s) {
  const out = [];
  let depth = 0;
  let inQ = null;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      cur += c;
      if (c === inQ) inQ = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inQ = c;
      cur += c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== "");
}
function unquote(s) {
  const m = /^\s*"(.*)"\s*$/.exec(s) || /^\s*'(.*)'\s*$/.exec(s);
  return m ? m[1] : s.trim();
}
function lexExpr(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "	") {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ t: "num", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/%()".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    return null;
  }
  return out;
}
function evalExpr(src, vars) {
  const lexed = lexExpr(src);
  if (!lexed) return null;
  const toks = lexed;
  let p = 0;
  const peek = () => toks[p];
  const eat = (v2) => (v2 ? peek()?.v === v2 : peek()) && toks[p++];
  function primary() {
    const t = peek();
    if (!t) return null;
    if (eat("(")) {
      const v2 = expr();
      if (!eat(")") || v2 === null) return null;
      return v2;
    }
    if (t.t === "num") {
      p++;
      return Number(t.v);
    }
    if (t.t === "id") {
      p++;
      return vars[t.v] ?? NaN;
    }
    if (t.v === "-") {
      p++;
      const v2 = primary();
      return v2 === null ? null : -v2;
    }
    return null;
  }
  function term() {
    let a = primary();
    if (a === null) return null;
    while (peek() && (peek().v === "*" || peek().v === "/" || peek().v === "%")) {
      const op = toks[p++].v;
      const b = primary();
      if (b === null) return null;
      a = op === "*" ? a * b : op === "/" ? a / b : a % b;
    }
    return a;
  }
  function expr() {
    let a = term();
    if (a === null) return null;
    while (peek() && (peek().v === "+" || peek().v === "-")) {
      const op = toks[p++].v;
      const b = term();
      if (b === null) return null;
      a = op === "+" ? a + b : a - b;
    }
    return a;
  }
  const v = expr();
  if (v === null || !Number.isFinite(v) || p !== toks.length) return null;
  return v;
}
function expandDirective(inner, vars, lists, errors) {
  const name = /^([A-Za-z]+)\s*\(/.exec(inner)?.[1]?.toLowerCase();
  const paren = inner.indexOf("(");
  const body = paren >= 0 ? readParen(inner, paren) : null;
  if (!name || !body) {
    errors.push(`\u65E0\u6CD5\u8BC6\u522B\u7684\u6A21\u677F\u6307\u4EE4 <${inner}>`);
    return "";
  }
  const argsStr = body.inner;
  switch (name) {
    case "list": {
      const items = lists.get(unquote(argsStr));
      if (!items || !items.length) {
        errors.push(`list(${unquote(argsStr)}) \u6CA1\u6709\u5BF9\u5E94\u7684\u5217\u8868\u5B9A\u4E49`);
        return "";
      }
      return String(items[vars.i % items.length]);
    }
    case "loop": {
      const items = splitTemplateArgs(argsStr).map(unquote);
      if (!items.length) {
        errors.push("loop() \u91CC\u81F3\u5C11\u8981\u6709\u4E00\u4E2A\u503C");
        return "";
      }
      return String(items[vars.i % items.length]);
    }
    case "int": {
      const args = splitTemplateArgs(argsStr);
      if (!args.length) {
        errors.push("int() \u9700\u8981\u4E00\u4E2A\u516C\u5F0F");
        return "";
      }
      const v = evalExpr(args[0], vars);
      if (v === null) {
        errors.push(`int("${args[0]}") \u7684\u516C\u5F0F\u65E0\u6CD5\u8BA1\u7B97`);
        return "";
      }
      const n = Math.floor(v);
      const width = args.length > 1 ? Number(args[1]) : 0;
      if (width > 0 && Number.isFinite(width)) return String(Math.abs(n)).padStart(width, "0");
      return String(n);
    }
    default:
      errors.push(`\u6682\u4E0D\u652F\u6301\u7684\u6A21\u677F\u6307\u4EE4 <${name}(...)>`);
      return "";
  }
}
function render(template, midi, lowMidi, lists, errors) {
  const vars = { i: midi - lowMidi, m: midi };
  let out = "";
  let i = 0;
  while (i < template.length) {
    if (template[i] === "<") {
      const j = template.indexOf(">", i);
      if (j < 0) {
        out += template.slice(i);
        break;
      }
      out += expandDirective(template.slice(i + 1, j), vars, lists, errors);
      i = j + 1;
      continue;
    }
    out += template[i];
    i++;
  }
  return out;
}
function expandKeysoundPath(input) {
  const files = /* @__PURE__ */ new Map();
  const errors = [];
  const lo = Math.min(input.low, input.high);
  const hi = Math.max(input.low, input.high);
  for (let m = lo; m <= hi; m++) {
    files.set(m, render(input.pattern, m, lo, input.lists, errors));
  }
  return { files, errors: [...new Set(errors)] };
}
function parsePitchToken(raw) {
  const s = raw.trim().replace(/^["']|["']$/g, "");
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^([A-Ga-g])([#s]?)(-?\d)$/.exec(s);
  if (m) {
    const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    const semi = base[m[1].toUpperCase()] + (m[2] ? 1 : 0);
    return (Number(m[3]) + 1) * 12 + semi;
  }
  return null;
}

// src/core/body.ts
var INDEX_LEFT = /* @__PURE__ */ new Set([" ", "	", "/", "|", "[", "(", ">"]);
function tokenizeBody(src, base, diags) {
  const toks = [];
  let i = 0;
  const push = (t, from, to, extra) => {
    toks.push({ t, s: src.slice(from, to), from: base + from, to: base + to, ...extra });
  };
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "	" || c === "\r") {
      i++;
      continue;
    }
    if (c === "#") {
      if (src[i + 1] === "#" || i === 0 || src[i - 1] === " " || src[i - 1] === "	") break;
    }
    if (c === "/") {
      push("bar", i, i + 1);
      i++;
      continue;
    }
    if (c === "-") {
      push("dash", i, i + 1);
      i++;
      continue;
    }
    if (c === "=") {
      push("rest", i, i + 1);
      i++;
      continue;
    }
    if (c === "(") {
      push("lp", i, i + 1);
      i++;
      continue;
    }
    if (c === ")") {
      push("rp", i, i + 1);
      i++;
      continue;
    }
    if (c === "[") {
      push("lb", i, i + 1);
      i++;
      continue;
    }
    if (c === "]") {
      push("rb", i, i + 1);
      i++;
      continue;
    }
    if (c === "|") {
      push("pipe", i, i + 1);
      i++;
      continue;
    }
    if (c === "*") {
      push("star", i, i + 1);
      i++;
      continue;
    }
    if (c === "<") {
      const j = src.indexOf(">", i);
      if (j < 0) {
        diags.push({
          from: base + i,
          to: base + src.length,
          severity: "error",
          message: '\u6307\u4EE4\u7F3A\u5C11\u53F3\u5C16\u62EC\u53F7 ">"',
          code: "dir-unclosed"
        });
        break;
      }
      push("dir", i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "@") {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      if (j === i + 1) {
        diags.push({
          from: base + i,
          to: base + i + 1,
          severity: "error",
          message: "@ \u540E\u9762\u9700\u8981\u4E50\u53E5\u540D",
          code: "phrase-empty"
        });
        i++;
        continue;
      }
      push("phrase", i, j);
      i = j;
      continue;
    }
    if (c === "^" || c === "_") {
      let j = i;
      while (j < src.length && src[j] === c) j++;
      push(c === "^" ? "caret" : "under", i, j);
      i = j;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < src.length && src[j] >= "0" && src[j] <= "9") j++;
      const asIndex = i === 0 || INDEX_LEFT.has(src[i - 1]);
      push("num", i, j, { asIndex });
      i = j;
      continue;
    }
    if (c >= "A" && c <= "Z") {
      let j = i + 1;
      while (j < src.length && src[j] >= "a" && src[j] <= "z") j++;
      push("note", i, j);
      i = j;
      continue;
    }
    diags.push({
      from: base + i,
      to: base + i + 1,
      severity: "error",
      message: `\u65E0\u6CD5\u8BC6\u522B\u7684\u5B57\u7B26 "${c}"`,
      code: "body-char"
    });
    i++;
  }
  return toks;
}
var STANDARD_NAMES = /* @__PURE__ */ new Set(["W", "F", "C", "Ws", "Fs", "Cs", "Wfcs", "Dwfcs"]);
function sumDur(units) {
  return units.reduce((s, u) => s + u.dur, 0);
}
function matchParen(toks, i, end, open, close, ctx) {
  let depth = 0;
  for (let j = i; j < end; j++) {
    if (toks[j].t === open) depth++;
    else if (toks[j].t === close) {
      depth--;
      if (depth === 0) return j;
    } else if (toks[j].t === "bar") break;
  }
  ctx.diags.push({
    from: toks[i].from,
    to: toks[i].to,
    severity: "error",
    message: "\u62EC\u53F7\u6CA1\u6709\u95ED\u5408",
    code: "paren-unclosed"
  });
  return end;
}
function applyDirective(t, ctx) {
  const inner = t.s.slice(1, -1).trim();
  const m = /^(volume|v)\s*=\s*(-?\d+)$/i.exec(inner);
  if (m) {
    const v = Number(m[2]);
    if (v < 0 || v > 100) {
      ctx.diags.push({
        from: t.from,
        to: t.to,
        severity: "warning",
        message: `\u97F3\u91CF ${v} \u8D85\u51FA 0~100 \u7684\u8303\u56F4`,
        code: "volume-range"
      });
    }
    ctx.volume = Math.max(0, Math.min(100, v));
    return;
  }
  const m2 = /^(index|i)\s*=\s*(\d+)$/i.exec(inner);
  if (m2) {
    ctx.index = Number(m2[2]);
    return;
  }
  ctx.diags.push({
    from: t.from,
    to: t.to,
    severity: "warning",
    message: `\u672A\u8BC6\u522B\u7684\u6307\u4EE4 <${inner}>\uFF08\u76EE\u524D\u652F\u6301 <v=\u6570\u503C> / <volume=\u6570\u503C>\uFF09`,
    code: "dir-unknown"
  });
}
function cloneUnit(u) {
  return { ...u, children: u.children ? u.children.map(cloneUnit) : void 0 };
}
function isKeysound(ctx) {
  return ctx.mode === "keysound";
}
function pitchStateOf(ctx, staff) {
  if (!ctx.pitchStates) ctx.pitchStates = /* @__PURE__ */ new Map();
  let st = ctx.pitchStates.get(staff);
  if (!st) {
    st = newPitchState();
    ctx.pitchStates.set(staff, st);
  }
  return st;
}
function instrumentOf(ctx, staff) {
  const list = ctx.instruments || [];
  return list[staff]?.name ?? list[list.length - 1]?.name;
}
function resolveKeysoundNote(t, st, rel, absOct, ctx) {
  const letter = t.s;
  if (letter.length !== 1 || letterToSemi(letter) === null) {
    ctx.diags.push({
      from: t.from,
      to: t.to,
      severity: "error",
      message: `[Keysound] \u91CC "${letter}" \u4E0D\u662F\u97F3\u7B26\u4EE3\u53F7\uFF08\u53EA\u80FD\u7528 C H D I E F J G K A L B\uFF0C\u5176\u4E2D H I J K L \u662F\u9ED1\u952E\uFF09`,
      code: "ks-note"
    });
    return null;
  }
  const useAbs = rel === 0 ? absOct !== null ? absOct : st.octave : null;
  return resolvePitch(letter, st, { rel, absOct: useAbs });
}
function parseUnits(toks, from, to, ctx, nested) {
  const out = [];
  const ks = isKeysound(ctx);
  let pendingRel = 0;
  let pendingOct = null;
  let i = from;
  while (i < to) {
    const t = toks[i];
    if (t.t === "bar") break;
    if (t.t === "pipe") {
      if (ks && !nested) ctx.staff = (ctx.staff ?? 0) + 1;
      i++;
      continue;
    }
    if (t.t === "caret" || t.t === "under") {
      if (!ks) {
        ctx.diags.push({
          from: t.from,
          to: t.to,
          severity: "error",
          message: `"${t.s}" \u662F\u76F8\u5BF9\u516B\u5EA6\u8BB0\u53F7\uFF0C\u53EA\u6709 [Keysound] \u6B63\u6587\u624D\u652F\u6301`,
          code: "oct-outside"
        });
        i++;
        continue;
      }
      pendingRel += t.t === "caret" ? t.s.length : -t.s.length;
      i++;
      continue;
    }
    if (t.t === "dir") {
      applyDirective(t, ctx);
      i++;
      continue;
    }
    if (t.t === "num" && t.asIndex) {
      if (ks) {
        const n = Number(t.s);
        if (n < 0 || n > 8)
          ctx.diags.push({
            from: t.from,
            to: t.to,
            severity: "warning",
            message: `\u516B\u5EA6 ${n} \u8D85\u51FA\u94A2\u7434\u97F3\u57DF\uFF080~8\uFF09\uFF0C\u4F1A\u5F80\u97F3\u57DF\u5185\u62C9`,
            code: "oct-range"
          });
        pendingOct = n;
      } else ctx.index = Number(t.s);
      i++;
      continue;
    }
    if (t.t === "dash") {
      if (out.length) out[out.length - 1].dur += 1;
      else if (!nested) ctx.leadDash += 1;
      else
        ctx.diags.push({
          from: t.from,
          to: t.to,
          severity: "warning",
          message: '\u5EF6\u97F3\u7B26 "-" \u524D\u9762\u6CA1\u6709\u53EF\u5EF6\u957F\u7684\u97F3\u7B26',
          code: "dash-orphan"
        });
      i++;
      continue;
    }
    if (t.t === "lp" || t.t === "lb") {
      const close = t.t === "lp" ? "rp" : "rb";
      const j = matchParen(toks, i, to, t.t, close, ctx);
      const children = parseUnits(toks, i + 1, j, ctx, true);
      const base = {
        kind: "group",
        mode: t.t === "lp" ? "h" : "v",
        children,
        dur: 1,
        vol: ctx.volume,
        idx: ctx.index,
        from: t.from,
        to: toks[Math.min(j, to - 1)].to,
        line: ctx.lineOf(t.from)
      };
      i = Math.min(j + 1, to);
      if (i < to && toks[i].t === "num" && !toks[i].asIndex) {
        base.dur = Number(toks[i].s);
        base.to = toks[i].to;
        i++;
      }
      while (i < to && toks[i].t === "dash") {
        base.dur += 1;
        base.to = toks[i].to;
        i++;
      }
      let reps = 1;
      if (i < to && toks[i].t === "star") {
        const nt = toks[i + 1];
        if (nt && nt.t === "num") {
          reps = Number(nt.s);
          i += 2;
        } else {
          ctx.diags.push({
            from: t.from,
            to: t.to,
            severity: "error",
            message: "* \u540E\u9762\u9700\u8981\u4E00\u4E2A\u91CD\u590D\u6B21\u6570",
            code: "star-nonum"
          });
          i++;
        }
      }
      if (reps < 1) reps = 1;
      for (let k = 0; k < reps; k++) {
        const cp = k === 0 ? base : cloneUnit(base);
        out.push(cp);
      }
      continue;
    }
    if (t.t === "note" || t.t === "rest") {
      let dur = 1;
      let endTok = i;
      i++;
      let guard = 0;
      while (i < to && guard++ < 64) {
        if (toks[i].t === "dash") {
          dur += 1;
          endTok = i;
          i++;
          continue;
        }
        if (toks[i].t === "num" && !toks[i].asIndex) {
          dur = Number(toks[i].s);
          endTok = i;
          i++;
          continue;
        }
        break;
      }
      let reps = 1;
      if (i < to && toks[i].t === "star") {
        const nt = toks[i + 1];
        if (nt && nt.t === "num") {
          reps = Number(nt.s);
          endTok = i + 1;
          i += 2;
        } else {
          ctx.diags.push({
            from: toks[i].from,
            to: toks[i].to,
            severity: "error",
            message: "* \u540E\u9762\u9700\u8981\u4E00\u4E2A\u91CD\u590D\u6B21\u6570",
            code: "star-nonum"
          });
          i++;
        }
      }
      if (t.t === "note" && !ks) {
        const name = t.s;
        if (!ctx.defined.has(name) && !(ctx.standardFormat && STANDARD_NAMES.has(name))) {
          if (!ctx.undefinedNames.has(name)) {
            ctx.undefinedNames.add(name);
            ctx.diags.push({
              from: t.from,
              to: t.to,
              severity: "warning",
              message: `\u97F3\u6548 "${name}" \u672A\u5728 [Define] \u4E2D\u5B9A\u4E49`,
              code: "hs-undefined"
            });
          }
        }
      }
      if (reps < 1) reps = 1;
      for (let k = 0; k < reps; k++) {
        const unit = {
          kind: t.t === "note" ? "note" : "rest",
          name: t.t === "note" ? t.s : void 0,
          dur: dur < 1 ? 1 : dur,
          vol: ctx.volume,
          idx: ctx.index,
          from: t.from,
          to: toks[endTok].to,
          line: ctx.lineOf(t.from)
        };
        if (ks && t.t === "note") {
          const staff = ctx.staff ?? 0;
          const st = pitchStateOf(ctx, staff);
          const pitch = resolveKeysoundNote(t, st, pendingRel, k === 0 ? pendingOct : null, ctx);
          if (pitch !== null) {
            unit.pitch = pitch;
            unit.name = midiToName(pitch);
          }
          unit.staff = staff;
        }
        out.push(unit);
      }
      pendingRel = 0;
      pendingOct = null;
      continue;
    }
    if (t.t === "phrase") {
      const name = t.s.slice(1);
      const ph = ctx.phrases.get(name);
      if (!ph) {
        ctx.diags.push({
          from: t.from,
          to: t.to,
          severity: "error",
          message: `\u672A\u5B9A\u4E49\u7684\u4E50\u53E5 @${name}`,
          code: "phrase-undefined"
        });
        i++;
        continue;
      }
      const kids = getPhraseUnits(ph, ctx);
      const isAlone = !nested && from === i && to === i + 1;
      const base = {
        kind: "phrase",
        mode: "h",
        phraseName: name,
        children: kids.map(cloneUnit),
        dur: isAlone ? sumDur(kids) : 1,
        vol: ctx.volume,
        idx: ctx.index,
        from: t.from,
        to: t.to,
        line: ctx.lineOf(t.from)
      };
      i++;
      if (i < to && toks[i].t === "num" && !toks[i].asIndex) {
        base.dur = Number(toks[i].s);
        i++;
      }
      let reps = 1;
      if (i < to && toks[i].t === "star") {
        const nt = toks[i + 1];
        if (nt && nt.t === "num") {
          reps = Number(nt.s);
          i += 2;
        } else {
          i++;
        }
      }
      if (!isAlone && !nested) {
        ctx.diags.push({
          from: t.from,
          to: t.to,
          severity: "warning",
          message: `\u4E50\u53E5 @${name} \u6CA1\u6709\u72EC\u5360\u5C0F\u8282\uFF0C\u5EFA\u8BAE\u7528\u65B9\u62EC\u53F7\u62EC\u8D77\u6765 [@${name}]`,
          code: "phrase-notalone"
        });
      }
      if (reps < 1) reps = 1;
      for (let k = 0; k < reps; k++) out.push(k === 0 ? base : cloneUnit(base));
      continue;
    }
    if (t.t === "num") {
      ctx.diags.push({
        from: t.from,
        to: t.to,
        severity: "warning",
        message: "\u6570\u5B57\u5DE6\u4FA7\u4E0D\u662F\u97F3\u7B26/\u53F3\u62EC\u53F7\uFF0C\u65E0\u6CD5\u4F5C\u4E3A\u65F6\u503C\uFF1B\u82E5\u8981\u8868\u793A\u97F3\u6548\u7EC4\u7F16\u53F7\uFF0C\u8BF7\u5728\u5B83\u5DE6\u8FB9\u7559\u7A7A\u683C",
        code: "num-orphan"
      });
      i++;
      continue;
    }
    if (t.t === "star") {
      ctx.diags.push({
        from: t.from,
        to: t.to,
        severity: "error",
        message: "* \u5DE6\u4FA7\u7F3A\u5C11\u8981\u91CD\u590D\u7684\u97F3\u7B26\u6216\u7247\u6BB5",
        code: "star-orphan"
      });
      i++;
      continue;
    }
    if (t.t === "rp" || t.t === "rb") {
      ctx.diags.push({
        from: t.from,
        to: t.to,
        severity: "error",
        message: "\u591A\u4F59\u7684\u53F3\u62EC\u53F7",
        code: "paren-extra"
      });
      i++;
      continue;
    }
    i++;
  }
  return out;
}
var phraseCache = /* @__PURE__ */ new WeakMap();
function getPhraseUnits(ph, ctx) {
  const cached = phraseCache.get(ph);
  if (cached) return cached;
  const toks = tokenizeBody(ph.body, ph.from, ctx.diags);
  const units = parseUnits(toks, 0, toks.length, ctx, false);
  phraseCache.set(ph, units);
  return units;
}
function emitUnit(u, start, span, out, ctx, measure) {
  if (u.kind === "note") {
    const ks = isKeysound(ctx);
    out.push({
      time: start,
      duration: span,
      names: [u.name],
      volume: u.vol ?? 100,
      index: u.idx,
      measure: measure.index + 1,
      unitPos: 0,
      beat: beatAt(measure, start),
      line: u.line,
      from: u.from,
      to: u.to,
      ...ks ? {
        kind: "keysound",
        pitch: u.pitch,
        staff: u.staff ?? 0,
        instrument: u.staff !== void 0 ? instrumentOf(ctx, u.staff) : void 0
      } : { kind: "hitsound" }
    });
    return;
  }
  if (u.kind === "rest") return;
  const kids = u.children || [];
  if (u.mode === "v") {
    for (const ch of kids) emitUnit(ch, start, span, out, ctx, measure);
    return;
  }
  const total = sumDur(kids) || 1;
  let c = start;
  for (const ch of kids) {
    const s = span * ch.dur / total;
    emitUnit(ch, c, s, out, ctx, measure);
    c += s;
  }
}
function parseMarkerText(raw, ctx, line) {
  const body = raw.trim();
  const mk = (m2) => ({
    raw: body,
    kind: "ms",
    time: null,
    measure: null,
    line: line.index + 1,
    from: line.start,
    to: line.end,
    ...m2
  });
  const fail = (msg) => {
    ctx.diags.push({ from: line.start, to: line.end, severity: "error", message: msg, code: "marker-bad" });
    return mk({});
  };
  let m = /^(\d+)$/.exec(body);
  if (m) return mk({ kind: "ms", time: Number(m[1]) });
  m = /^(\d{1,3}):([0-5]?\d)[:.](\d{1,3})$/.exec(body);
  if (m) {
    const ms = Number(m[3]) * Math.pow(10, 3 - m[3].length);
    return mk({ kind: "clock", time: Number(m[1]) * 6e4 + Number(m[2]) * 1e3 + ms });
  }
  m = /^bookmark\s*\(\s*(\d+)\s*\)$/i.exec(body);
  if (m) {
    const n = Number(m[1]);
    const b = ctx.bookmarks;
    if (!b || n >= b.length)
      return fail(`#bookmark(${n}) \u8D85\u51FA\u8303\u56F4\uFF1ABookmarks \u53EA\u6709 ${b ? b.length : 0} \u9879`);
    return mk({ kind: "bookmark", arg: n, time: b[n] });
  }
  m = /^timing\s*\(\s*(\d+)\s*\)$/i.exec(body);
  if (m) {
    const n = Number(m[1]);
    const tp = ctx.timing[n];
    if (!tp) return fail(`#timing(${n}) \u8D85\u51FA\u8303\u56F4\uFF1A[Timing] \u53EA\u6709 ${ctx.timing.length} \u6761`);
    return mk({ kind: "timing", arg: n, time: tp.offset + (tp.shift || 0) });
  }
  return fail(
    `\u65E0\u6CD5\u8BC6\u522B\u7684\u6BB5\u843D\u6807\u8BB0 "#${body}"\uFF08\u53EF\u7528\uFF1A#123456 / #2:03.456 / #02:03:456 / #bookmark(0) / #timing(0)\uFF09`
  );
}
function parseHitsoundBody(lines2, ctx) {
  const events = [];
  const markers = [];
  let measureCursor = 0;
  let lastRegion = null;
  let pendingSpan = 0;
  for (const line of lines2) {
    if (line.code.trimStart().startsWith("#")) {
      const marker = parseMarkerText(line.code.trimStart().slice(1), ctx, line);
      if (marker.time !== null) {
        const mi = ctx.grid.indexAt(marker.time);
        marker.measure = mi;
        measureCursor = mi;
        lastRegion = null;
      }
      markers.push(marker);
      continue;
    }
    const toks = tokenizeBody(line.code, line.start, ctx.diags);
    if (!toks.some((t) => t.t === "bar")) {
      if (line.code.trim()) {
        ctx.diags.push({
          from: line.start,
          to: line.end,
          severity: "info",
          message: '\u8BE5\u884C\u4E0D\u4EE5 "/" \u5F00\u5934\uFF0C\u5DF2\u6309\u6307\u4EE4\u884C\u5FFD\u7565',
          code: "not-phrase"
        });
      }
      continue;
    }
    const regions = [];
    let cur = [];
    let started = false;
    for (const t of toks) {
      if (t.t === "bar") {
        if (!started) {
          if (cur.length) {
            ctx.diags.push({
              from: cur[0].from,
              to: cur[cur.length - 1].to,
              severity: "error",
              message: '\u4E50\u53E5\u5FC5\u987B\u4EE5\u5C0F\u8282\u7EBF "/" \u5F00\u5934',
              code: "no-leading-bar"
            });
            cur = [];
          }
          started = true;
          continue;
        }
        regions.push({
          toks: cur,
          barsBefore: 1,
          from: cur.length ? cur[0].from : t.from,
          to: cur.length ? cur[cur.length - 1].to : t.from
        });
        cur = [];
      } else {
        cur.push(t);
      }
    }
    if (started && cur.length) {
      regions.push({
        toks: cur,
        barsBefore: 1,
        from: cur[0].from,
        to: cur[cur.length - 1].to
      });
      ctx.diags.push({
        from: cur[cur.length - 1].to,
        to: line.end,
        severity: "warning",
        message: '\u8BE5\u884C\u672B\u5C3E\u7F3A\u5C11\u5C0F\u8282\u7EBF "/"\uFF0C\u5DF2\u81EA\u52A8\u8865\u5168',
        code: "bar-missing"
      });
    }
    let k = 0;
    let extra = 0;
    while (k < regions.length && regions[k].toks.length === 0) {
      extra += regions[k].barsBefore;
      k++;
    }
    if (extra > 0 && k < regions.length) {
      regions[k].barsBefore += extra;
      regions.splice(0, k);
    } else if (extra > 0) {
      regions.splice(0, k);
    }
    for (const region of regions) {
      if (region.toks.length === 1 && region.toks[0].t === "num") {
        const n = Number(region.toks[0].s);
        if (!(n >= 1)) {
          ctx.diags.push({
            from: region.from,
            to: region.to,
            severity: "error",
            message: `\u5C0F\u8282\u8DE8\u5EA6\u5FC5\u987B\u662F\u6B63\u6574\u6570\uFF0C\u6536\u5230 "${region.toks[0].s}"`,
            code: "span-bad"
          });
          continue;
        }
        pendingSpan = (pendingSpan > 0 ? pendingSpan : region.barsBefore) + n - 1;
        continue;
      }
      let span = region.barsBefore;
      if (pendingSpan > 0) {
        span = pendingSpan;
        pendingSpan = 0;
      }
      let units;
      if (region.toks.length === 2 && region.toks[0].t === "star" && region.toks[1].t === "num") {
        const reps = Number(region.toks[1].s);
        if (!lastRegion) {
          ctx.diags.push({
            from: region.from,
            to: region.to,
            severity: "error",
            message: '\u91CD\u590D\u8BB0\u53F7 "*n" \u524D\u9762\u6CA1\u6709\u53EF\u91CD\u590D\u7684\u5C0F\u8282',
            code: "repeat-orphan"
          });
          continue;
        }
        for (let r = 0; r < reps; r++) {
          place(lastRegion.units.map(cloneUnit), lastRegion.span);
        }
        continue;
      }
      ctx.leadDash = 0;
      ctx.staff = 0;
      const staves = isKeysound(ctx) ? splitByPipe(region.toks) : [region.toks];
      if (staves.length > 1) {
        const all = [];
        const baseIdx = measureCursor;
        for (let si = 0; si < staves.length; si++) {
          if (!staves[si].length) continue;
          ctx.staff = si;
          ctx.leadDash = 0;
          const sub = parseUnits(staves[si], 0, staves[si].length, ctx, false);
          place(sub, span, si === 0 ? void 0 : baseIdx);
          all.push(...sub);
        }
        lastRegion = { units: all, span };
        continue;
      }
      units = parseUnits(region.toks, 0, region.toks.length, ctx, false);
      lastRegion = { units, span };
      place(units, span);
    }
  }
  function splitByPipe(toks) {
    const out = [];
    let cur = [];
    let depth = 0;
    for (const t of toks) {
      if (t.t === "lp" || t.t === "lb") depth++;
      if (t.t === "rp" || t.t === "rb") depth--;
      if (t.t === "pipe" && depth === 0) {
        out.push(cur);
        cur = [];
        continue;
      }
      cur.push(t);
    }
    out.push(cur);
    return out;
  }
  function place(units, span, at) {
    const idx = at !== void 0 ? at : measureCursor;
    if (at === void 0) measureCursor += span;
    const first = ctx.grid.get(idx);
    const last = ctx.grid.get(idx + span - 1);
    const start = first.start;
    const end = last.end;
    const lead = ctx.leadDash;
    ctx.leadDash = 0;
    const total = lead + sumDur(units);
    if (total <= 0) return;
    const unitDur = (end - start) / total;
    if (lead > 0 && events.length) {
      const prev = events[events.length - 1];
      prev.duration += lead * unitDur;
    }
    let cursor = start + lead * unitDur;
    for (const u of units) {
      const s = u.dur * unitDur;
      emitUnit(u, cursor, s, events, ctx, first);
      cursor += s;
    }
  }
  events.sort((a, b) => a.time - b.time || a.from - b.from);
  let lastMeasure = -1;
  let lastStart = 0;
  let lastLen = 1;
  for (const e of events) {
    if (e.measure !== lastMeasure) {
      lastMeasure = e.measure;
      const m = ctx.grid.get(e.measure - 1);
      lastStart = m.start;
      lastLen = m.end - m.start || 1;
    }
    e.unitPos = (e.time - lastStart) / lastLen;
  }
  return { events, measures: ctx.grid.snapshot(), usedMeasures: measureCursor, markers };
}

// src/core/parse.ts
var MIN_GRID_MEASURES = 32;
var TAIL_GRID_MEASURES = 8;
var MAX_GRID_MEASURES = 2e4;
function splitLines(text) {
  const out = [];
  let pos = 0;
  const raw = text.split(/\r?\n/);
  raw.forEach((t, i) => {
    const { code } = stripComment(t);
    out.push({ text: t, code, start: pos, end: pos + t.length, index: i });
    pos += t.length + 1;
  });
  return out;
}
function stripComment(text) {
  let inQuote = false;
  for (let i = 0; i < text.length - 1; i++) {
    const c = text[i];
    if (c === '"') inQuote = !inQuote;
    if (inQuote) continue;
    if (c === "#" && text[i + 1] === "#") return { code: text.slice(0, i), end: i };
  }
  return { code: text, end: text.length };
}
var SET_MAP = {
  soft: "soft",
  normal: "normal",
  drum: "drum",
  s: "soft",
  n: "normal",
  d: "drum"
};
var TYPE_MAP = {
  hitnormal: "hitnormal",
  hitwhistle: "hitwhistle",
  hitfinish: "hitfinish",
  hitclap: "hitclap",
  sliderside: "sliderside",
  slidertick: "slidertick",
  n: "hitnormal",
  w: "hitwhistle",
  f: "hitfinish",
  c: "hitclap",
  s: "sliderside",
  t: "slidertick"
};
function parseAlt(raw, from, to, diags, abs) {
  const r = raw.trim().toLowerCase();
  if (r === "custom") return { raw, custom: true, from: abs + from, to: abs + to };
  if (r.includes("-")) {
    const [a, b] = r.split("-");
    const ss = SET_MAP[a];
    const tt = TYPE_MAP[b];
    if (!ss || !tt) {
      diags.push({
        from: abs + from,
        to: abs + to,
        severity: "error",
        message: `\u65E0\u6CD5\u8BC6\u522B\u7684\u97F3\u6548\u69FD\u4F4D "${raw}"\uFF08\u53EF\u7528\uFF1Asoft/normal/drum + hitnormal/hitwhistle/hitfinish/hitclap/sliderside/slidertick\uFF0C\u6216\u7F29\u5199\u5982 sc\u3001dw\uFF09`,
        code: "slot-unknown"
      });
    }
    return {
      raw,
      custom: false,
      sampleSet: ss,
      hitType: tt,
      from: abs + from,
      to: abs + to
    };
  }
  if (TYPE_MAP[r] && (r === "sliderside" || r === "slidertick")) {
    return { raw, custom: false, hitType: TYPE_MAP[r], from: abs + from, to: abs + to };
  }
  if (r.length === 2) {
    const ss = SET_MAP[r[0]];
    const tt = TYPE_MAP[r[1]];
    if (!ss || !tt) {
      diags.push({
        from: abs + from,
        to: abs + to,
        severity: "error",
        message: `\u65E0\u6CD5\u8BC6\u522B\u7684\u97F3\u6548\u69FD\u4F4D\u7F29\u5199 "${raw}"`,
        code: "slot-unknown"
      });
    }
    return { raw, custom: false, sampleSet: ss, hitType: tt, from: abs + from, to: abs + to };
  }
  diags.push({
    from: abs + from,
    to: abs + to,
    severity: "error",
    message: `\u65E0\u6CD5\u8BC6\u522B\u7684\u97F3\u6548\u69FD\u4F4D "${raw}"`,
    code: "slot-unknown"
  });
  return { raw, custom: false, from: abs + from, to: abs + to };
}
function parseSlotPart(s, abs, diags) {
  const alts = [];
  const indices = [];
  let rest = s;
  let pos = 0;
  let guard = 0;
  while (pos < rest.length && guard++ < 32) {
    while (pos < rest.length && rest[pos] === " ") pos++;
    if (pos >= rest.length) break;
    let j = pos;
    while (j < rest.length && rest[j] !== "|" && rest[j] !== "{" && rest[j] !== " ") j++;
    const raw = rest.slice(pos, j);
    if (raw) alts.push(parseAlt(raw, pos, j, diags, abs));
    pos = j;
    if (rest[pos] === "{") {
      let depth = 0;
      let k = pos;
      for (; k < rest.length; k++) {
        if (rest[k] === "{") depth++;
        else if (rest[k] === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      const inner = rest.slice(pos + 1, k);
      indices.push(...parseIndexList(inner, abs + pos, diags));
      pos = Math.min(k + 1, rest.length);
    }
    if (rest[pos] === "|") {
      pos++;
      continue;
    }
    break;
  }
  while (pos < rest.length && rest[pos] === " ") pos++;
  return { alts, indices, name: rest.slice(pos).trim(), nameStart: pos };
}
function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") depth--;
    if (c === sep && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}
function parseIndexList(inner, abs, diags) {
  const out = [];
  for (const part of splitTopLevel(inner, ",")) {
    const p = part.trim();
    if (!p) continue;
    let m = /^\((\d+)\s*,\s*(\d+)\)$/.exec(p);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      out.push({ from: Math.min(a, b), to: Math.max(a, b) });
      continue;
    }
    m = /^(\d+)$/.exec(p);
    if (m) {
      const a = Number(m[1]);
      out.push({ from: a, to: a });
      continue;
    }
    diags.push({
      from: abs,
      to: abs + inner.length + 2,
      severity: "error",
      message: `\u65E0\u6CD5\u89E3\u6790\u7684\u97F3\u6548\u7EC4\u7F16\u53F7 "${p}"\uFF08\u5E94\u4E3A\u6570\u5B57\u6216 (a,b) \u533A\u95F4\uFF09`,
      code: "index-bad"
    });
  }
  return out;
}
function parseBraceList(s) {
  const m = /\{([\s\S]*)\}/.exec(s);
  const inner = m ? m[1] : s;
  return inner.split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}
function parseBool(s) {
  return /^(true|1|yes|on)$/i.test(s.trim());
}
function parseNumberExpr(s) {
  const t = s.trim();
  let m = /^bpm\(([-\d.]+)\)$/i.exec(t);
  if (m) {
    const b = Number(m[1]);
    return b > 0 ? 6e4 / b : NaN;
  }
  m = /^beat\(([-\d.]+),([-\d.]+),([-\d.]+)\)$/i.exec(t);
  if (m) {
    const [, x, y, z] = m;
    const zz = Number(z);
    return zz === 0 ? Number(x) : Number(x) + Number(y) / zz;
  }
  if (/^[-\d.]+$/.test(t)) return Number(t);
  return NaN;
}
function isAbsolute(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
}
function resolvePath(base, p) {
  if (!p) return "";
  if (isAbsolute(p)) {
    return /^[A-Za-z]:/.test(p) || p.startsWith("\\\\") ? p.replace(/\//g, "\\") : p;
  }
  if (!base) return p;
  const b = base.replace(/[\\/]+$/, "");
  return `${b}\\${p.replace(/^[\\/]+/, "").replace(/\//g, "\\")}`;
}
function dirname(p) {
  const m = /^(.*)[\\/][^\\/]*$/.exec(p.replace(/\//g, "\\"));
  return m ? m[1] : "";
}
function defaultSettings() {
  return {
    Path: "",
    Audio: "",
    Mode: "default",
    Key: ["A", "B", "C", "D"],
    AutoHitsoundIndex: true,
    SliderSlideHitsound: false,
    SliderTickHitsound: false,
    SpinnerHitsound: false,
    DefaultOverride: false,
    StandardFormat: false,
    PreferredIndex: [],
    TimingAdsorb: 0.5,
    TimingAdsorbRaw: "beat(0,1,2)",
    Bookmarks: [],
    BookmarksRaw: "",
    Song: ""
  };
}
var FILES_KEYS = /* @__PURE__ */ new Set(["path", "audio"]);
var SECTION_RE = /^\[([A-Za-z]+)\]\s*$/;
function migrateSongToFiles(src) {
  if (/^\s*\[Files\]/im.test(src)) return src;
  const m = /^[ \t]*Song[ \t]*=[ \t]*(".*?"|'.*?'|\S+)[ \t]*\r?\n?/im.exec(src);
  if (!m) return src;
  const value = m[1].trim().replace(/^["']|["']$/g, "");
  if (!value) return src;
  const dir = dirname(value);
  const file = value.replace(/\\/g, "/").split("/").pop() || value;
  const block = `[Files]
path = "${dir}"
audio = "${file}"
`;
  let out = src.replace(m[0], "");
  if (/^\s*\[Settings\]/im.test(out)) out = out.replace(/^([ \t]*)\[Settings\]/im, `$1${block}
$1[Settings]`);
  else out = block + "\n" + out;
  return out.replace(/\n[ \t]*\n[ \t]*\n/, "\n\n");
}
function parseChart(text, opts = {}) {
  const diags = [];
  const lines2 = splitLines(text);
  const metadata = {};
  const metadataOrder = [];
  const settings = defaultSettings();
  const hitsounds = [];
  const phrases = [];
  const lists = [];
  const timing = [];
  const sections = [];
  const keyInstruments = [];
  const keyBodyLines = [];
  let seenKeyInst = false;
  let section = "";
  const bodyLines = [];
  const lineOf = (pos) => {
    let lo = 0;
    let hi = lines2.length - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (lines2[mid].start <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  for (let li = 0; li < lines2.length; li++) {
    const line = lines2[li];
    const code = line.code.trim();
    if (!code) continue;
    const sec = SECTION_RE.exec(code);
    if (sec) {
      if (section) sections[sections.length - 1].to = lines2[li - 1]?.end ?? line.start;
      section = sec[1].toLowerCase();
      if (section === "keysound") seenKeyInst = false;
      sections.push({ name: sec[1], from: line.start, to: text.length });
      continue;
    }
    if (!section) {
      if (!/^##/.test(line.text.trim()))
        diags.push({
          from: line.start,
          to: line.end,
          severity: "warning",
          message: "\u8BE5\u884C\u4F4D\u4E8E\u4EFB\u4F55\u5C0F\u8282\uFF08[xxx]\uFF09\u4E4B\u524D\uFF0C\u4F1A\u88AB\u5FFD\u7565",
          code: "no-section"
        });
      continue;
    }
    switch (section) {
      case "metadata": {
        const m = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(code);
        if (!m) {
          diags.push({
            from: line.start,
            to: line.end,
            severity: "error",
            message: '\u5143\u6570\u636E\u5E94\u4E3A "\u952E = \u503C" \u7684\u5F62\u5F0F',
            code: "meta-bad"
          });
          break;
        }
        if (!metadataOrder.includes(m[1])) metadataOrder.push(m[1]);
        metadata[m[1]] = m[2].trim();
        break;
      }
      case "files": {
        const m = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(code);
        if (!m) {
          diags.push({
            from: line.start,
            to: line.end,
            severity: "error",
            message: '[Files] \u5E94\u4E3A "\u952E = \u503C" \u7684\u5F62\u5F0F\uFF08\u53EF\u7528 path / audio\uFF09',
            code: "files-bad"
          });
          break;
        }
        const key = m[1].toLowerCase();
        const val = m[2].trim().replace(/^["']|["']$/g, "");
        if (!FILES_KEYS.has(key)) {
          diags.push({
            from: line.start,
            to: line.end,
            severity: "warning",
            message: `[Files] \u6682\u4E0D\u652F\u6301 "${m[1]}"\uFF0C\u76EE\u524D\u53EA\u6709 path \u548C audio`,
            code: "files-unknown"
          });
          break;
        }
        if (key === "path") settings.Path = val;
        else settings.Audio = val;
        break;
      }
      case "settings": {
        const m = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(code);
        if (!m) {
          diags.push({
            from: line.start,
            to: line.end,
            severity: "error",
            message: '\u8BBE\u7F6E\u9879\u5E94\u4E3A "\u952E = \u503C" \u7684\u5F62\u5F0F',
            code: "set-bad"
          });
          break;
        }
        const key = m[1];
        const val = m[2].trim();
        switch (key.toLowerCase()) {
          case "mode":
            if (!/^(default|taiko|mania)$/.test(val))
              diags.push({
                from: line.start,
                to: line.end,
                severity: "error",
                message: "Mode \u53EA\u80FD\u662F default / taiko / mania",
                code: "set-mode"
              });
            else settings.Mode = val;
            break;
          case "key":
            settings.Key = parseBraceList(val);
            break;
          case "autohitsoundindex":
            settings.AutoHitsoundIndex = parseBool(val);
            break;
          case "sliderslidehitsound":
            settings.SliderSlideHitsound = parseBool(val);
            break;
          case "slidertickhitsound":
            settings.SliderTickHitsound = parseBool(val);
            break;
          case "spinnerhitsound":
            settings.SpinnerHitsound = parseBool(val);
            break;
          case "defaultoverride":
            settings.DefaultOverride = parseBool(val);
            break;
          case "standardformat":
            settings.StandardFormat = parseBool(val);
            break;
          case "preferredindex":
            settings.PreferredIndex = parseBraceList(val).map((x) => Number(x)).filter((n) => !Number.isNaN(n));
            break;
          case "bookmarks": {
            settings.BookmarksRaw = val;
            const nums = [];
            for (const x of parseBraceList(val)) {
              const n = Number(x);
              if (Number.isNaN(n)) {
                diags.push({
                  from: line.start,
                  to: line.end,
                  severity: "error",
                  message: `Bookmarks \u91CC\u7684 "${x}" \u4E0D\u662F\u6570\u5B57\uFF08\u5355\u4F4D\u4E0E [Timing] \u6BCF\u884C\u7B2C\u4E00\u9879\u76F8\u540C\uFF0C\u6BEB\u79D2\uFF09`,
                  code: "set-bookmarks"
                });
              } else nums.push(n);
            }
            settings.Bookmarks = nums;
            break;
          }
          case "timingadsorb": {
            const n = parseNumberExpr(val);
            settings.TimingAdsorbRaw = val;
            if (Number.isNaN(n))
              diags.push({
                from: line.start,
                to: line.end,
                severity: "error",
                message: "TimingAdsorb \u5E94\u4E3A\u6570\u5B57\u6216 beat(x,y,z)",
                code: "set-adsorb"
              });
            else settings.TimingAdsorb = n;
            break;
          }
          case "song":
            settings.Song = val.replace(/^["']|["']$/g, "");
            if (!settings.Audio) {
              settings.Audio = settings.Song;
              if (!settings.Path) settings.Path = dirname(settings.Song);
            }
            diags.push({
              from: line.start,
              to: line.end,
              severity: "warning",
              message: '[Settings] \u7684 Song \u5DF2\u8FC1\u79FB\u5230 [Files] \u7684 audio\uFF0C\u5EFA\u8BAE\u6539\u5199\u4E3A [Files] path = "..." / audio = "..."',
              code: "set-song-deprecated"
            });
            break;
          default:
            diags.push({
              from: line.start,
              to: line.end,
              severity: "warning",
              message: `\u672A\u77E5\u7684\u8BBE\u7F6E\u9879 "${key}"`,
              code: "set-unknown"
            });
        }
        break;
      }
      case "define": {
        if (code.startsWith("list")) {
          const m = /^list\s+(\w+)\s+(\w+)\s*\{?\s*$/.exec(code);
          if (!m) {
            diags.push({
              from: line.start,
              to: line.end,
              severity: "error",
              message: "\u5217\u8868\u5B9A\u4E49\u5E94\u4E3A list <\u7C7B\u578B> <\u540D\u79F0> { ... }\uFF0C\u7C7B\u578B\u53EF\u7528 int/float/string",
              code: "list-bad"
            });
            break;
          }
          let body2 = "";
          let endLine = li;
          const braceHere = code.includes("{");
          if (!braceHere) {
            endLine = li + 1;
          }
          if (braceHere && code.includes("}")) {
            body2 = code.slice(code.indexOf("{") + 1, code.lastIndexOf("}"));
          } else {
            let buf = braceHere ? code.slice(code.indexOf("{") + 1) : "";
            while (endLine < lines2.length) {
              const l = lines2[endLine].code;
              if (l.includes("}")) {
                buf += " " + l.slice(0, l.indexOf("}"));
                break;
              }
              buf += " " + l;
              endLine++;
            }
            body2 = buf;
          }
          const items = (body2.match(/"[^"]*"|'[^']*'|[^\s,]+/g) || []).map((x) => x.replace(/^["']|["']$/g, "")).filter(Boolean);
          lists.push({
            name: m[2],
            type: m[1],
            items,
            from: line.start,
            to: lines2[Math.min(endLine, lines2.length - 1)].end,
            line: li + 1
          });
          li = endLine;
          break;
        }
        if (code.startsWith("@")) {
          const m = /^@([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(code);
          if (!m) {
            diags.push({
              from: line.start,
              to: line.end,
              severity: "error",
              message: "\u4E50\u53E5\u5B9A\u4E49\u5E94\u4E3A @\u540D\u79F0 = /.../",
              code: "phrase-bad"
            });
            break;
          }
          const raw = m[2].trim();
          const a = raw.indexOf("/");
          const b = raw.lastIndexOf("/");
          if (a < 0 || b <= a) {
            diags.push({
              from: line.start,
              to: line.end,
              severity: "error",
              message: '\u4E50\u53E5\u5185\u5BB9\u9700\u8981\u7528 "/" \u5305\u88F9',
              code: "phrase-body"
            });
            break;
          }
          const bodyStart = line.start + line.code.indexOf(m[2]) + a + 1;
          phrases.push({
            name: m[1],
            body: raw.slice(a + 1, b),
            from: bodyStart,
            to: bodyStart + (b - a - 1),
            line: li + 1
          });
          break;
        }
        if (code.startsWith("hitsound") || code.startsWith("keysound")) {
          const isKs = code.startsWith("keysound");
          const rest = code.slice(isKs ? 8 : 8);
          const eq = rest.indexOf("=");
          if (eq < 0) {
            diags.push({
              from: line.start,
              to: line.end,
              severity: "error",
              message: "\u97F3\u6548\u5B9A\u4E49\u5E94\u4E3A hitsound <\u69FD\u4F4D> [\u540D\u79F0] = <\u8DEF\u5F84\u6216 default.xxx>",
              code: "hs-bad"
            });
            break;
          }
          const leftPart = rest.slice(0, eq);
          const rightPart = rest.slice(eq + 1).trim();
          const leftAbs = line.start + line.code.indexOf(leftPart);
          const { alts, indices, name } = parseSlotPart(leftPart, leftAbs, diags);
          let value = rightPart;
          let defaultRef;
          let path;
          let keys;
          let soundFont = false;
          if (/^default\./i.test(value)) {
            defaultRef = value.slice(8);
          } else if (/^\(([\s\S]*)\)\s*$/.test(value) && isKs) {
            const args = splitTemplateArgs(value.replace(/^\(|\)\s*$/g, ""));
            if (args.length < 3) {
              diags.push({
                from: line.start + line.code.indexOf(rightPart),
                to: line.end,
                severity: "error",
                message: 'keysound \u591A\u6587\u4EF6\u5B9A\u4E49\u5E94\u4E3A ("\u8DEF\u5F84\u6A21\u677F", \u6700\u4F4E\u97F3, \u6700\u9AD8\u97F3 [, \u8C03\u5F8B])\uFF0C\u4F8B\u5982 ("piano/<loop("A","A#")><int((i+9)/12)>.wav", A0, C8)',
                code: "ks-args"
              });
            }
            const lo = parsePitchToken(args[1] ?? "");
            const hi = parsePitchToken(args[2] ?? "");
            const tune = args[3] !== void 0 ? Number(args[3]) : 0;
            keys = {
              pattern: unquote(args[0] ?? ""),
              low: lo ?? PIANO_LOW,
              high: hi ?? PIANO_HIGH,
              tune: Number.isFinite(tune) ? tune : 0
            };
            if (lo === null || hi === null)
              diags.push({
                from: line.start + line.code.indexOf(rightPart),
                to: line.end,
                severity: "warning",
                message: `\u6700\u4F4E/\u6700\u9AD8\u97F3 "${args[1] ?? ""}" / "${args[2] ?? ""}" \u65E0\u6CD5\u8BC6\u522B\uFF0C\u5DF2\u6309 A0~C8 \u5904\u7406`,
                code: "ks-range"
              });
          } else if (/^".*"$/.test(value) || /^'.*'$/.test(value)) {
            path = value.slice(1, -1);
          } else {
            path = value;
            diags.push({
              from: line.start + line.code.indexOf(rightPart),
              to: line.end,
              severity: "warning",
              message: "\u8DEF\u5F84\u5EFA\u8BAE\u7528\u5F15\u53F7\u5305\u88F9",
              code: "hs-quote"
            });
          }
          if (/\.(sf2|sf3)$/i.test(path || "")) soundFont = true;
          if (name && !(isKs ? /^[A-Za-z][A-Za-z0-9_]*$/.test(name) : /^[A-Z][a-z]*$/.test(name))) {
            diags.push({
              from: leftAbs + leftPart.length - name.length,
              to: leftAbs + leftPart.length,
              severity: "error",
              message: isKs ? `keysound \u540D "${name}" \u4E0D\u7B26\u5408\u547D\u540D\u89C4\u5219\uFF08\u5E94\u4EE5\u5B57\u6BCD\u5F00\u5934\uFF0C\u540E\u53EF\u8DDF\u5B57\u6BCD/\u6570\u5B57/\u4E0B\u5212\u7EBF\uFF09` : `\u97F3\u6548\u540D "${name}" \u4E0D\u7B26\u5408\u547D\u540D\u89C4\u5219\uFF08\u5FC5\u987B\u4EE5\u5927\u5199\u5B57\u6BCD\u5F00\u5934\uFF0C\u540E\u53EF\u8DDF\u5C0F\u5199\u5B57\u6BCD\uFF09`,
              code: "hs-name"
            });
          }
          const nameFrom = leftAbs + leftPart.trimEnd().length - name.length;
          hitsounds.push({
            kind: isKs ? "keysound" : "hitsound",
            name: name || void 0,
            nameFrom: name ? nameFrom : leftAbs,
            nameTo: name ? nameFrom + name.length : leftAbs,
            alts,
            indices,
            value,
            defaultRef,
            path,
            keys,
            soundFont,
            from: line.start,
            to: line.end,
            line: li + 1
          });
          break;
        }
        diags.push({
          from: line.start,
          to: line.end,
          severity: "warning",
          message: "\u65E0\u6CD5\u8BC6\u522B\u7684 [Define] \u8BED\u53E5\uFF08\u652F\u6301 hitsound / @\u4E50\u53E5 / list\uFF09",
          code: "define-unknown"
        });
        break;
      }
      case "timing": {
        const parts = code.split(",").map((x) => x.trim());
        if (parts.length < 3) {
          diags.push({
            from: line.start,
            to: line.end,
            severity: "error",
            message: "Timing \u81F3\u5C11\u8981\u6709 \u65F6\u95F4\u8F74,\u6BCF\u62CD\u6BEB\u79D2\u6570,\u6BCF\u5C0F\u8282\u62CD\u6570 \u4E09\u4E2A\u5B57\u6BB5",
            code: "timing-fields"
          });
          break;
        }
        const offset = Number(parts[0]);
        const bl2 = parseNumberExpr(parts[1]);
        const meter = Number(parts[2]);
        const resetMode = parts[3] !== void 0 ? Number(parts[3]) : 0;
        const rbExpr = parts[4] !== void 0 ? parseNumberExpr(parts[4]) : 0;
        const shift = parts[5] !== void 0 ? Number(parts[5]) : 0;
        if (Number.isNaN(offset))
          diags.push({
            from: line.start,
            to: line.end,
            severity: "error",
            message: "\u65F6\u95F4\u8F74\u4E0D\u662F\u5408\u6CD5\u6570\u5B57",
            code: "timing-offset"
          });
        if (Number.isNaN(bl2) || !(bl2 > 0))
          diags.push({
            from: line.start,
            to: line.end,
            severity: "error",
            message: "\u6BCF\u62CD\u6BEB\u79D2\u6570\u65E0\u6548\uFF08\u53EF\u7528 bpm(135) \u6216\u76F4\u63A5\u5199\u6BEB\u79D2\uFF09",
            code: "timing-beat"
          });
        if (!(meter > 0))
          diags.push({
            from: line.start,
            to: line.end,
            severity: "error",
            message: "\u6BCF\u5C0F\u8282\u62CD\u6570\u5FC5\u987B\u4E3A\u6B63\u6574\u6570",
            code: "timing-meter"
          });
        timing.push({
          offset: Number.isNaN(offset) ? 0 : offset,
          beatLength: Number.isNaN(bl2) ? 500 : bl2,
          meter: meter > 0 ? meter : 4,
          resetMode: resetMode === 1 || resetMode === 2 ? resetMode : 0,
          resetBeats: Number.isNaN(rbExpr) ? 0 : rbExpr,
          resetBeatsSet: parts[4] !== void 0 && !Number.isNaN(rbExpr),
          shift: Number.isNaN(shift) ? 0 : shift,
          from: line.start,
          to: line.end,
          line: li + 1
        });
        break;
      }
      case "hitsound": {
        bodyLines.push({
          text: line.text,
          code: line.code,
          start: line.start,
          end: line.end,
          index: li
        });
        break;
      }
      case "keysound": {
        if (!seenKeyInst) {
          if (!code.trim()) break;
          if (!code.startsWith("{")) {
            diags.push({
              from: line.start,
              to: line.end,
              severity: "error",
              message: `\u672C\u884C\u4E0D\u4EE5 "/" \u5F00\u5934\u3002\u4E50\u5668\u5217\u8868\u5E94\u4F7F\u7528\u82B1\u62EC\u53F7\u586B\u5199\uFF1A{\u4E50\u5668A | \u4E50\u5668B}`,
              code: "ks-instbad"
            });
            break;
          }
          seenKeyInst = true;
          const inner = code.slice(1, code.lastIndexOf("}") < 0 ? void 0 : code.lastIndexOf("}"));
          const base = line.start + line.code.indexOf(inner);
          let staff = 0;
          for (const raw of inner.split("|")) {
            const nm = raw.trim();
            if (!nm) continue;
            keyInstruments.push({
              name: nm,
              staff: staff++,
              from: base + inner.indexOf(nm),
              to: base + inner.indexOf(nm) + nm.length,
              line: li + 1
            });
          }
          if (!keyInstruments.length)
            diags.push({
              from: line.start,
              to: line.end,
              severity: "error",
              message: "\u4E50\u5668\u5217\u8868\u4E3A\u7A7A\uFF0C\u81F3\u5C11\u8981\u5199\u4E00\u4E2A\u5728 [Define] \u91CC\u5B9A\u4E49\u7684 keysound \u540D",
              code: "ks-instempty"
            });
          break;
        }
        keyBodyLines.push({
          text: line.text,
          code: line.code,
          start: line.start,
          end: line.end,
          index: li
        });
        break;
      }
      case "hitobjects":
        break;
      default:
        break;
    }
  }
  if (sections.length) sections[sections.length - 1].to = text.length;
  const audioPath = resolvePath(settings.Path, settings.Audio);
  for (const h of hitsounds) {
    if (h.path) h.resolvedPath = resolvePath(settings.Path, h.path);
  }
  const grid = new MeasureGrid(timing, diags);
  const defined = /* @__PURE__ */ new Set();
  for (const h of hitsounds) if (h.name) defined.add(h.name);
  const phraseMap = /* @__PURE__ */ new Map();
  for (const p of phrases) {
    if (phraseMap.has(p.name))
      diags.push({
        from: p.from,
        to: p.to,
        severity: "warning",
        message: `\u4E50\u53E5 @${p.name} \u91CD\u590D\u5B9A\u4E49\uFF0C\u540E\u9762\u7684\u4F1A\u8986\u76D6\u524D\u9762\u7684`,
        code: "phrase-dup"
      });
    phraseMap.set(p.name, p);
  }
  const undefinedNames = /* @__PURE__ */ new Set();
  const ctx = {
    diags,
    phrases: phraseMap,
    defined,
    standardFormat: settings.StandardFormat,
    grid,
    volume: 100,
    index: null,
    undefinedNames,
    leadDash: 0,
    lineOf,
    timing,
    bookmarks: settings.Bookmarks
  };
  const listMap = /* @__PURE__ */ new Map();
  for (const l of lists) listMap.set(l.name, l.items);
  const ksNames = /* @__PURE__ */ new Set();
  for (const h of hitsounds) if (h.kind === "keysound" && h.name) ksNames.add(h.name);
  for (const inst of keyInstruments) {
    if (ksNames.has(inst.name)) continue;
    diags.push({
      from: inst.from,
      to: inst.to,
      severity: "error",
      message: `\u4E50\u5668 "${inst.name}" \u6CA1\u6709\u5728 [Define] \u91CC\u7528 keysound \u5B9A\u4E49\u8FC7`,
      code: "ks-undefined"
    });
  }
  for (const h of hitsounds) {
    if (h.kind !== "keysound" || !h.keys) continue;
    const res = expandKeysoundPath({ pattern: h.keys.pattern, low: h.keys.low, high: h.keys.high, tune: h.keys.tune, lists: listMap });
    const files = /* @__PURE__ */ new Map();
    for (const [midi, rel] of res.files) files.set(midi, resolvePath(settings.Path, rel));
    h.keyFiles = files;
    for (const e of res.errors)
      diags.push({ from: h.from, to: h.to, severity: "error", message: e, code: "ks-pattern" });
  }
  const body = parseHitsoundBody(bodyLines, ctx);
  const keyCtx = {
    ...ctx,
    mode: "keysound",
    staff: 0,
    volume: 100,
    index: null,
    leadDash: 0,
    pitchStates: /* @__PURE__ */ new Map(),
    instruments: keyInstruments
  };
  const keyBody = keyBodyLines.length ? parseHitsoundBody(keyBodyLines, keyCtx) : null;
  let events = body.events;
  let usedMeasures = body.usedMeasures;
  if (keyBody) {
    usedMeasures = Math.max(usedMeasures, keyBody.usedMeasures);
    events = [...events, ...keyBody.events].sort((a, b) => a.time - b.time || a.from - b.from);
    let lastMeasure = -1;
    let lastStart = 0;
    let lastLen = 1;
    for (const e of events) {
      if (e.measure !== lastMeasure) {
        lastMeasure = e.measure;
        const m = grid.get(e.measure - 1);
        lastStart = m.start;
        lastLen = m.end - m.start || 1;
      }
      e.unitPos = (e.time - lastStart) / lastLen;
    }
  }
  const lastTp = timing.length ? timing[timing.length - 1] : void 0;
  let tailTarget = 0;
  if (lastTp) {
    const bl2 = lastTp.beatLength > 0 ? lastTp.beatLength : 500;
    const meter = lastTp.meter > 0 ? lastTp.meter : 4;
    tailTarget = lastTp.offset + TAIL_GRID_MEASURES * meter * bl2;
  }
  let gridCount = Math.max(usedMeasures, MIN_GRID_MEASURES);
  if (tailTarget > 0) {
    while (gridCount < MAX_GRID_MEASURES && grid.get(gridCount - 1).end < tailTarget) gridCount++;
  }
  const songEnd = opts.audioDurationMs;
  if (typeof songEnd === "number" && Number.isFinite(songEnd) && songEnd > 0) {
    while (gridCount < MAX_GRID_MEASURES && grid.get(gridCount - 1).end < songEnd) gridCount++;
  }
  grid.get(gridCount - 1);
  diags.sort((a, b) => a.from - b.from);
  return {
    text,
    metadata,
    metadataOrder,
    settings,
    audioPath,
    hitsounds,
    phrases,
    lists,
    timing,
    events,
    measures: grid.snapshot(),
    usedMeasures,
    diagnostics: diags,
    sections,
    markers: body.markers,
    undefinedNames: [...undefinedNames],
    keyInstruments
  };
}

// src/samples/demo.ts
var DEMO = `[Metadata]
Title = Hiiro no Bara
TitleUnicode = \u7DCB\u8272\u306E\u8594\u8587
Artist = Shimotsuki Haruka
ArtistUnicode = \u971C\u6708\u306F\u308B\u304B
Creator = foo bar
Source = \u660E\u65E5\u65B9\u821F
Tags = foo bar
BeatmapID = 114514
BeatmapSetID = 1919810

[Files]
## path \u662F\u540E\u9762\u6240\u6709\u76F8\u5BF9\u8DEF\u5F84\u7684\u57FA\u51C6\u76EE\u5F55\uFF0Caudio \u662F\u76F8\u5BF9 path \u7684\u97F3\u9891\u6587\u4EF6
path = "E:\\osu\\Songs\\foobar"
audio = "audio.mp3"

[Settings]
Mode = default                  ## \u6E38\u620F\u6A21\u5F0F\uFF1Adefault / taiko / mania
Key = {D, F, J, K}              ## mania \u952E\u4F4D\u4EE3\u53F7
AutoHitsoundIndex = true        ## \u81EA\u52A8\u97F3\u6548\u7EC4\u7F16\u53F7
SliderSlideHitsound = false     ## \u6ED1\u6761\u8EAB\u97F3\u6548
SliderTickHitsound = false      ## \u6ED1\u6761\u70B9\u97F3\u6548
SpinnerHitsound = false         ## \u8F6C\u76D8\u5C3E\u97F3\u6548
DefaultOverride = false         ## \u9ED8\u8BA4\u97F3\u6548\u8986\u5199
StandardFormat = false          ## \u6807\u51C6\u683C\u5F0F\uFF08\u5F00\u542F\u540E\u53EA\u80FD\u7528 W F C Ws Fs Cs Wfcs Dwfcs\uFF09
PreferredIndex = {11, 45, 14}   ## \u4F18\u5148\u97F3\u6548\u7EC4\u7F16\u53F7
TimingAdsorb = beat(0,1,2)      ## \u65F6\u95F4\u8F74\u5438\u9644\uFF0C\u9ED8\u8BA4 1/2 \u62CD
Bookmarks = {114514, 1919810}   ## \u4E66\u7B7E\uFF08\u6BEB\u79D2\uFF09\uFF0C\u6B63\u6587\u91CC\u7528 #bookmark(0) \u5F15\u7528

[Define]
## \u5B9A\u4E49\u97F3\u6548\uFF1Ahitsound <\u69FD\u4F4D> [\u540D\u79F0] = <\u8DEF\u5F84\u6216 default.xxx>
hitsound custom D = default.normal-hitnormal
hitsound custom K = "D:\\Music\\Kick.wav"
hitsound custom J = "hs/Juju.wav"
hitsound soft-hitclap Wx = "Wax.wav"
hitsound drum-hitwhistle{11,45,14} Wy = "Way.wav"
hitsound normal-hitfinish|soft-hitfinish{(1,5),(11,15)} Ni = "finish.ogg"
hitsound sliderside = default.blank

## \u5B9A\u4E49\u4E50\u53E5\uFF0C@\u540E\u9762\u53EA\u80FD\u662F\u5B57\u6BCD\u548C\u6570\u5B57
@Fill = /K (KK) (KKK) (KKKK)/
@Backbeat = /D - K -/

## keysound\uFF08\u6709\u97F3\u9AD8\u7684\u97F3\u6548\uFF09\uFF1A\u6BCF\u4E2A\u97F3\u9AD8\u4E00\u4E2A wav\uFF0C\u6A21\u677F\u91CC\u7528 <loop()> \u5217\u97F3\u540D\u3001<int()> \u7B97\u516B\u5EA6
## \u4E0B\u9762\u8FD9\u884C\u4F1A\u6309 A0.wav \u2026 C8.wav \u5C55\u5F00 88 \u4E2A\u97F3\u9AD8\uFF1B\u7B2C\u4E8C\u4E2A\u5199\u6CD5\u662F\u97F3\u8272\u5E93\u6587\u4EF6\uFF08.sf2/.sf3\uFF09
keysound custom piano = ("piano/<loop("A","L","B","C","H","D","I","E","F","J","G","K")><int((i+9)/12)>.wav", A0, C8)
keysound custom guitar = "guitar.sf2"      ## \u97F3\u8272\u5E93\u6A21\u5F0F\uFF08\u6682\u4E0D\u652F\u6301\u89E3\u7801\uFF0C\u4F1A\u7528\u5185\u7F6E\u5408\u6210\u97F3\u8BD5\u542C\uFF09

[Timing]
## \u65F6\u95F4\u8F74(ms), \u6BCF\u62CD\u6BEB\u79D2\u6570(\u53EF\u7528 bpm(135)), \u6BCF\u5C0F\u8282\u62CD\u6570, \u91CD\u7F6E\u6A21\u5F0F, \u91CD\u7F6E\u62CD\u6570, \u504F\u79FB
839,bpm(174),4,0,0

[Keysound]
## \u7B2C\u4E00\u884C\u7528\u82B1\u62EC\u53F7\u6307\u5B9A\u5404\u8C31\u8868\u4F7F\u7528\u7684\u4E50\u5668
{piano}
## \u97F3\u7B26\u662F\u97F3\u540D\u4EE3\u53F7\uFF1AC H D I E F J G K A L B\uFF08H I J K L \u662F\u9ED1\u952E\uFF09
## \u6570\u5B57\u5728\u7A7A\u683C/\u659C\u6760\u540E\u8868\u793A\u7EDD\u5BF9\u516B\u5EA6\uFF1B^ \u4E0A\u79FB\u3001_ \u4E0B\u79FB\u76F8\u5BF9\u516B\u5EA6
/4C D E F/
/^G _C/
#02:03.456
/4A/

[Hitsound]
## \u6BCF\u884C\u4EE5 / \u5F00\u5934\uFF0C\u4E24\u4E2A / \u4E4B\u95F4\u662F\u4E00\u4E2A\u5C0F\u8282
/D D K (DD) (DD) (DD) K -/
/@Backbeat/ D D K K/
//K*16/
/[@Fill] [@Fill]/
/*3/
/<v=70> D D D K/
/(D K)*4/
/ 5 D - K - Wx/

## "#" \u5F00\u5934\u662F\u6BB5\u843D\u6807\u8BB0\uFF0C\u540E\u9762\u7684\u5185\u5BB9\u4ECE\u8BE5\u65F6\u95F4\u70B9\u7EE7\u7EED
#02:03.456
## /5/ \u7B49\u4EF7\u4E8E /////\uFF1A\u628A\u4E0B\u4E00\u5C0F\u8282\u7684\u5185\u5BB9\u644A\u5728 5 \u4E2A\u5C0F\u8282\u91CC
/5/ D - K -/
`;
var TEMPLATE = `[Metadata]
Title =
TitleUnicode =
Artist =
ArtistUnicode =
Creator =
Source =
Tags =
BeatmapID = 0
BeatmapSetID = -1

[Files]
path = ""
audio = ""

[Settings]
Mode = default
Key = {D, F, J, K}
AutoHitsoundIndex = true
SliderSlideHitsound = false
SliderTickHitsound = false
SpinnerHitsound = false
DefaultOverride = false
StandardFormat = false
PreferredIndex = {11, 45, 14}
TimingAdsorb = beat(0,1,2)
Bookmarks = {}

[Define]
hitsound custom D = default.normal-hitnormal

[Timing]
0,bpm(120),4,0,0

[Keysound]
## \u7B2C\u4E00\u884C\u7528\u82B1\u62EC\u53F7\u6307\u5B9A\u4E50\u5668\uFF0C\u4E50\u5668\u9700\u8981\u5148\u7528 keysound \u5B9A\u4E49\uFF0C\u4F8B\u5982\uFF1A
## keysound custom piano = ("piano/<loop("A","L","B","C")><int((i+9)/12)>.wav", A0, C8)
## {piano}
## /4C D E F/

[Hitsound]
## # \u5F00\u5934\u662F\u6BB5\u843D\u6807\u8BB0\uFF1A#123456 / #2:03.456 / #bookmark(0) / #timing(0)
/D D K K/
`;

// src/core/exporter.ts
function meta(doc2, key, fallback = "") {
  const v = doc2.metadata[key];
  return v === void 0 ? fallback : v;
}
function audioFileName(doc2) {
  const src = doc2.audioPath || doc2.settings.Audio || doc2.settings.Song;
  const song = src.replace(/\\/g, "/");
  const i = song.lastIndexOf("/");
  return i >= 0 ? song.slice(i + 1) : song;
}
function modeNumber(doc2) {
  return doc2.settings.Mode === "taiko" ? 1 : doc2.settings.Mode === "mania" ? 3 : 0;
}
function toOsu(doc2, version = "Hitsound") {
  const mode = modeNumber(doc2);
  const cs = mode === 3 ? String(Math.max(1, doc2.settings.Key.length)) : "5";
  const lines2 = [];
  lines2.push("osu file format v14", "");
  lines2.push("[General]");
  lines2.push(`AudioFilename: ${audioFileName(doc2)}`);
  lines2.push("AudioLeadIn: 0");
  lines2.push("PreviewTime: -1");
  lines2.push("Countdown: 0");
  lines2.push(`SampleSet: ${doc2.settings.Mode === "taiko" ? "Drum" : "Normal"}`);
  lines2.push("StackLeniency: 0.7");
  lines2.push(`Mode: ${mode}`);
  lines2.push("LetterboxInBreaks: 0");
  lines2.push("WidescreenStoryboard: 1", "");
  lines2.push("[Editor]");
  lines2.push("DistanceSpacing: 1");
  lines2.push("BeatDivisor: 4");
  lines2.push("GridSize: 4");
  lines2.push("TimelineZoom: 1");
  if (doc2.settings.Bookmarks.length) {
    lines2.push(`Bookmarks: ${doc2.settings.Bookmarks.map((b) => Math.round(b)).join(",")}`);
  }
  lines2.push("");
  lines2.push("[Metadata]");
  lines2.push(`Title:${meta(doc2, "Title", meta(doc2, "TitleUnicode"))}`);
  lines2.push(`TitleUnicode:${meta(doc2, "TitleUnicode")}`);
  lines2.push(`Artist:${meta(doc2, "Artist", meta(doc2, "ArtistUnicode"))}`);
  lines2.push(`ArtistUnicode:${meta(doc2, "ArtistUnicode")}`);
  lines2.push(`Creator:${meta(doc2, "Creator")}`);
  lines2.push(`Version:${version}`);
  lines2.push(`Source:${meta(doc2, "Source")}`);
  lines2.push(`Tags:${meta(doc2, "Tags")}`);
  lines2.push(`BeatmapID:${meta(doc2, "BeatmapID", "0")}`);
  lines2.push(`BeatmapSetID:${meta(doc2, "BeatmapSetID", "-1")}`, "");
  lines2.push("[Difficulty]");
  lines2.push("HPDrainRate:5");
  lines2.push(`CircleSize:${cs}`);
  lines2.push("OverallDifficulty:5");
  lines2.push("ApproachRate:5");
  lines2.push("SliderMultiplier:1.4");
  lines2.push("SliderTickRate:1", "");
  lines2.push("[Events]");
  lines2.push("//Background and Video events");
  lines2.push("//Break Periods");
  lines2.push("//Storyboard Layer 0 (Background)");
  lines2.push("//Storyboard Layer 1 (Fail)");
  lines2.push("//Storyboard Layer 2 (Pass)");
  lines2.push("//Storyboard Layer 3 (Foreground)", "");
  lines2.push("[TimingPoints]");
  for (const t of doc2.timing) {
    const bl2 = Number.isFinite(t.beatLength) ? t.beatLength : 500;
    lines2.push(`${Math.round(t.offset + (t.shift || 0))},${round6(bl2)},${t.meter},0,0,80,1,0`);
  }
  lines2.push("");
  lines2.push("// \u97F3\u6548\u6620\u5C04\u89C1\u300C\u5BFC\u51FA\u97F3\u6548\u6620\u5C04\u300D\uFF0C\u672C\u8282\u7531 osu Hitsound Studio \u751F\u6210");
  lines2.push("[HitObjects]");
  lines2.push("");
  return lines2.join("\r\n");
}
function round6(n) {
  const s = n.toFixed(6);
  return s.replace(/0+$/, "").replace(/\.$/, "");
}
function toTimelineCsv(doc2) {
  const rows = ["time_ms,beat,measure,unit_pos,sound,volume,index,duration_ms,line"];
  for (const e of doc2.events) {
    rows.push(
      [
        Math.round(e.time),
        e.beat.toFixed(4),
        e.measure,
        e.unitPos.toFixed(4),
        e.names.join("+"),
        e.volume,
        e.index ?? "",
        Math.round(e.duration),
        e.line
      ].join(",")
    );
  }
  return rows.join("\r\n");
}
function osuSections(raw) {
  const out = /* @__PURE__ */ new Map();
  let cur = "";
  for (const l of raw.split("\n")) {
    const m = /^\s*\[([A-Za-z0-9]+)\]\s*$/.exec(l);
    if (m) {
      cur = m[1].toLowerCase();
      if (!out.has(cur)) out.set(cur, []);
      continue;
    }
    if (!cur) continue;
    out.get(cur).push(l.replace(/\s+$/, ""));
  }
  return out;
}
function osuKV(lines2, sep) {
  const o = {};
  for (const l of lines2 || []) {
    const i = l.indexOf(sep);
    if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return o;
}
function templateBlock(template, name) {
  const sec = osuSections(template.replace(/\r\n/g, "\n"));
  return (sec.get(name.toLowerCase()) || []).filter((l) => l.trim());
}
var NO_INHERIT_GAP_MS = 2e3;
function fromOsu(src, template) {
  const raw = src.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const sec = osuSections(raw);
  const meta2 = osuKV(sec.get("metadata"), ":");
  const gen = osuKV(sec.get("general"), ":");
  const red = [];
  let skippedGreen = 0;
  for (const l of sec.get("timingpoints") || []) {
    if (!l.trim()) continue;
    const p = l.split(",").map((x) => x.trim());
    if (p.length < 2) continue;
    const off = Number(p[0]);
    const bl2 = Number(p[1]);
    if (!Number.isFinite(off) || !Number.isFinite(bl2)) continue;
    if (bl2 < 0) {
      skippedGreen++;
      continue;
    }
    if (!(bl2 > 0)) continue;
    const meter = Number(p[2]) || 4;
    red.push({ offset: off, beatLength: bl2, meter });
  }
  red.sort((a, b) => a.offset - b.offset);
  const tps = red.map((tp, i) => {
    const head = `${Math.round(tp.offset)},${round6(tp.beatLength)},${tp.meter}`;
    if (i === 0) return `${head},0,0`;
    const prev = red[i - 1];
    const gap = tp.offset - prev.offset;
    if (gap > NO_INHERIT_GAP_MS || tp.meter !== prev.meter) return `${head},1,0`;
    const beats = (tp.offset - prev.offset) / prev.beatLength;
    let rb = beats % prev.meter;
    if (rb < 1e-6 || prev.meter - rb < 1e-6) rb = 0;
    return `${head},0,${round6(rb)}`;
  });
  const metaKeys = [
    "Title",
    "TitleUnicode",
    "Artist",
    "ArtistUnicode",
    "Creator",
    "Source",
    "Tags",
    "BeatmapID",
    "BeatmapSetID"
  ];
  const metaLines = metaKeys.map((k) => `${k} = ${meta2[k] ?? ""}`);
  const modeMap = { "0": "default", "1": "taiko", "2": "default", "3": "mania" };
  let settingsLines = templateBlock(template, "settings").filter((l) => !/^\s*Song\s*=/i.test(l));
  if (!settingsLines.length) {
    settingsLines = templateBlock(DEFAULT_TEMPLATE_SETTINGS, "settings");
  }
  const osuMode = modeMap[gen["Mode"] ?? ""];
  if (osuMode) {
    const idx = settingsLines.findIndex((l) => /^\s*Mode\s*=/i.test(l));
    const line = `Mode = ${osuMode}`;
    if (idx >= 0) settingsLines[idx] = line;
    else settingsLines.unshift(line);
  }
  const ed = osuKV(sec.get("editor"), ":");
  const bms = (ed["Bookmarks"] ?? "").split(",").map((x) => x.trim()).filter((x) => x.length > 0).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n >= 0);
  let bookmarksCount = 0;
  if (bms.length) {
    bookmarksCount = bms.length;
    settingsLines = settingsLines.filter((l) => !/^\s*Bookmarks\s*=/i.test(l));
    settingsLines.push(`Bookmarks = {${bms.map((b) => Math.round(b)).join(", ")}}`);
  }
  const defineLines = templateBlock(template, "define");
  const hitsoundLines = templateBlock(template, "hitsound");
  const blocks = [];
  blocks.push(["[Metadata]", ...metaLines].join("\n"));
  blocks.push(["[Files]", 'path = ""', `audio = "${gen["AudioFilename"] ?? ""}"`].join("\n"));
  blocks.push(["[Settings]", ...settingsLines].join("\n"));
  if (defineLines.length) blocks.push(["[Define]", ...defineLines].join("\n"));
  blocks.push(["[Timing]", ...tps.length ? tps : ["0,bpm(120),4,0,0"]].join("\n"));
  blocks.push(["[Hitsound]", ...hitsoundLines.length ? hitsoundLines : ["/D D K K/"]].join("\n"));
  return { text: blocks.join("\n\n") + "\n", timingCount: tps.length, skippedGreen, bookmarksCount };
}
var DEFAULT_TEMPLATE_SETTINGS = `[Settings]
Mode = default
Key = {D, F, J, K}
AutoHitsoundIndex = true
SliderSlideHitsound = false
SliderTickHitsound = false
SpinnerHitsound = false
DefaultOverride = false
StandardFormat = false
PreferredIndex = {11, 45, 14}
TimingAdsorb = beat(0,1,2)
`;

// src/core/fileMatch.ts
function norm(p) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}
function matchKey(raw) {
  const n = norm(raw.replace(/^\s*["']|["']\s*$/g, "").trim());
  const i = n.lastIndexOf("/");
  const base = i >= 0 ? n.slice(i + 1) : n;
  const isAbs = /^[a-z]:/.test(n) || n.startsWith("//");
  return { rel: isAbs ? base : n, base };
}
function entriesFromFiles(files) {
  return files.map((file) => {
    const rp = file.webkitRelativePath || "";
    const raw = rp || file.name;
    let p = norm(raw);
    const i = p.indexOf("/");
    if (i > 0) p = p.slice(i + 1);
    const j = p.lastIndexOf("/");
    return { file, path: p, name: j >= 0 ? p.slice(j + 1) : p };
  });
}
function findEntry(entries, rel, base) {
  if (!rel && !base) return null;
  let best = null;
  for (const e of entries) {
    if (e.path === rel) return { file: e.file, how: "exact" };
    if (rel && e.path.endsWith("/" + rel)) {
      if (!best || e.path.length < best.len) best = { file: e.file, how: "suffix", len: e.path.length };
    }
  }
  if (best) return { file: best.file, how: best.how };
  if (base) {
    for (const e of entries) {
      if (e.name === base) return { file: e.file, how: "name" };
    }
  }
  return null;
}
function matchSong(doc2, entries) {
  const raw = doc2.settings.Audio || doc2.settings.Song || "";
  if (!raw) return null;
  const { rel, base } = matchKey(raw);
  const hit = findEntry(entries, rel, base);
  return { target: raw, relPath: rel, file: hit?.file ?? null, how: hit?.how ?? null };
}
function matchHitsounds(doc2, entries) {
  const out = [];
  for (const h of doc2.hitsounds) {
    if (!h.name) continue;
    if (h.defaultRef) continue;
    const raw = h.value || "";
    if (!raw) continue;
    const { rel, base } = matchKey(raw);
    const hit = findEntry(entries, rel, base);
    out.push({ target: h, relPath: rel, file: hit?.file ?? null, how: hit?.how ?? null });
  }
  return out;
}

// scripts/selftest.ts
var doc = parseChart(DEMO);
console.log("=== \u8BCA\u65AD ===");
doc.diagnostics.forEach((d) => console.log(`[${d.severity}] ${d.code || ""} ${d.message}`));
console.log("\n=== \u8BBE\u7F6E ===");
console.log(JSON.stringify(doc.settings, null, 1));
console.log("\n=== \u5B9A\u4E49 ===");
doc.hitsounds.forEach((h) => console.log(`${h.name}	${h.alts.map((a) => a.raw).join("|")}	${JSON.stringify(h.indices)}	${h.value}`));
console.log("\n=== \u524D 24 \u4E2A\u97F3\u7B26 ===");
doc.events.slice(0, 24).forEach((e) => {
  console.log(
    `t=${e.time.toFixed(1)}ms \u5C0F\u8282${e.measure} \u62CD${e.beat.toFixed(2)} ${e.kind === "keysound" ? `[KS ${e.instrument}] ${e.names.join("+")} midi=${e.pitch}` : `${e.names.join("+")} idx=${e.index}`} v=${e.volume}`
  );
});
console.log("\n=== \u5C0F\u8282\uFF08\u524D 12\uFF09 ===");
doc.measures.slice(0, 12).forEach(
  (m) => console.log(`#${m.index + 1} ${m.start.toFixed(1)} -> ${m.end.toFixed(1)} (${(m.end - m.start).toFixed(1)}ms) ${m.meter}/4 bl=${m.beatLength.toFixed(3)}`)
);
console.log(`
\u603B\u8BA1: ${doc.events.length} \u97F3\u7B26 / ${doc.measures.length} \u5C0F\u8282 / ${doc.diagnostics.length} \u8BCA\u65AD`);
console.log("\n=== .osu \u5BFC\u51FA\uFF08\u524D 40 \u884C\uFF09 ===");
console.log(toOsu(doc).split("\r\n").slice(0, 40).join("\n"));
console.log("\n=== CSV \u524D 5 \u884C ===");
console.log(toTimelineCsv(doc).split("\r\n").slice(0, 6).join("\n"));
var T = (name, cond, extra = "") => console.log(`${cond ? "PASS" : "FAIL"}  ${name} ${extra}`);
console.log("\n=== \u65AD\u8A00 ===");
var bl = 6e4 / 174;
T("\u5C0F\u8282\u957F\u5EA6 = 4 \u62CD", Math.abs(doc.measures[0].end - doc.measures[0].start - 4 * bl) < 0.01);
var firstTwo = doc.events.filter((e) => e.kind !== "keysound").slice(0, 2);
T("\u524D\u4E24\u62CD\u95F4\u9694 = 1/8 \u5C0F\u8282", Math.abs(firstTwo[1].time - firstTwo[0].time - 4 * bl / 8) < 0.01, `${(firstTwo[1].time - firstTwo[0].time).toFixed(2)}`);
var v70 = doc.events.filter((e) => e.volume === 70);
T("\u97F3\u91CF\u6307\u4EE4\u751F\u6548", v70.length > 0, `${v70.length} \u4E2A`);
var idx5 = doc.events.filter((e) => e.index === 5);
T("\u97F3\u6548\u7EC4\u7F16\u53F7\u751F\u6548", idx5.length > 0, `${idx5.length} \u4E2A`);
T("\u4E50\u53E5\u5C55\u5F00", doc.events.filter((e) => e.names[0] === "K").length > 20);
var d2 = parseChart(`[Timing]
0,bpm(120),4,0,0
[Hitsound]
/JJJ-/-JJ-/
`);
T("\u8DE8\u5C0F\u8282\u5EF6\u97F3\uFF1A\u7B2C 3 \u4E2A J \u65F6\u503C\u5EF6\u4F38\u5230\u4E0B\u4E00\u5C0F\u8282", d2.events.length === 5 && Math.abs(d2.events[2].duration - 1500) < 1, JSON.stringify(d2.events.map((e) => [Math.round(e.time), Math.round(e.duration)])));
var d3 = parseChart(`[Timing]
0,bpm(120),4,0,0
[Hitsound]
/D K/
/*3/
`);
T("\u5C0F\u8282\u91CD\u590D *3 => 8 \u4E2A\u97F3\u7B26", d3.events.length === 8, String(d3.events.length));
var d4 = parseChart(`[Timing]
0,bpm(120),4,0,0
[Hitsound]
/(A(BC))D/
`);
T("\u5D4C\u5957\u62EC\u53F7 (A(BC))D", d4.events.length === 4 && Math.abs(d4.events[1].time - 500) < 0.01 && Math.abs(d4.events[2].time - 750) < 0.01 && Math.abs(d4.events[3].time - 1e3) < 0.01, JSON.stringify(d4.events.map((e) => Math.round(e.time))));
var d5 = parseChart(`[Timing]
0,bpm(120),4,0,0
[Hitsound]
//K*16/
`);
T("\u4EE3\u7801\u5C0F\u8282 2 \u5C0F\u8282\u7B49\u5206 16 \u4EFD", d5.events.length === 16 && Math.abs(d5.events[15].time - 3750) < 0.01, JSON.stringify([d5.events[0].time, d5.events[15].time]));
var d6 = parseChart(`[Timing]
0,bpm(120),4,0,0
[Hitsound]
/C3C/
`);
T("C3C = \u9644\u70B9\u4E8C\u5206 + \u56DB\u5206", d6.events.length === 2 && Math.abs(d6.events[1].time - 1500) < 0.01, JSON.stringify(d6.events.map((e) => [Math.round(e.time), Math.round(e.duration)])));
console.log("\n=== [Files] ===");
var d7 = parseChart(
  `[Files]
path = "E:\\osu\\Songs\\foobar"
audio = "audio.mp3"
[Define]
hitsound custom K = "hs/Kick.wav"
hitsound custom X = "D:\\Music\\X.wav"
hitsound custom D = default.normal-hitnormal
`
);
console.log("audioPath =", d7.audioPath);
console.log(d7.hitsounds.map((h) => [h.name, h.value, h.resolvedPath]));
T("audio \u6309 path \u89E3\u6790", d7.audioPath === "E:\\osu\\Songs\\foobar\\audio.mp3", d7.audioPath);
T("\u76F8\u5BF9\u8DEF\u5F84\u97F3\u6548\u89E3\u6790", d7.hitsounds[0].resolvedPath === "E:\\osu\\Songs\\foobar\\hs\\Kick.wav");
T("\u7EDD\u5BF9\u8DEF\u5F84\u4FDD\u6301\u539F\u6837", d7.hitsounds[1].resolvedPath === "D:\\Music\\X.wav");
T("default.xxx \u65E0\u89E3\u6790\u8DEF\u5F84", d7.hitsounds[2].resolvedPath === void 0);
var d8 = parseChart(`[Settings]
Song = "E:/osu/songs/foo/bar.mp3"
`);
T("\u65E7\u7248 Song \u8FC1\u79FB\u5230 [Files]", d8.settings.Audio === "E:/osu/songs/foo/bar.mp3" && d8.settings.Path === "E:\\osu\\songs\\foo" && d8.audioPath === "E:\\osu\\songs\\foo\\bar.mp3", JSON.stringify([d8.settings.Path, d8.settings.Audio, d8.audioPath]));
T("Song \u7ED9\u51FA\u8FC1\u79FB\u63D0\u793A", d8.diagnostics.some((d) => d.code === "set-song-deprecated"));
var mig = migrateSongToFiles(`[Metadata]
Title = X

[Settings]
Mode = default
Song = "E:/osu/songs/foo/bar.mp3"
`);
console.log("\n=== \u8FC1\u79FB\u7ED3\u679C ===\n" + mig);
T("\u8FC1\u79FB\uFF1A\u63D2\u5165 [Files]", /\[Files\]\npath = "E:\\osu\\songs\\foo"\naudio = "bar\.mp3"/.test(mig));
T("\u8FC1\u79FB\uFF1A\u79FB\u9664\u65E7 Song \u884C", !/Song\s*=/.test(mig));
T("\u8FC1\u79FB\uFF1A\u5DF2\u6709 [Files] \u65F6\u4E0D\u52A8", migrateSongToFiles('[Files]\npath = "a"\n') === '[Files]\npath = "a"\n');
console.log("\n=== .osu \u5BFC\u5165 ===");
var OSU = [
  "osu file format v14",
  "",
  "[General]",
  "AudioFilename: audio.mp3",
  "Mode: 3",
  "",
  "[Metadata]",
  "Title:Foo",
  "TitleUnicode:\u30D5\u30FC",
  "Artist:Bar",
  "ArtistUnicode:\u30D0\u30FC",
  "Creator:me",
  "Version:Insane",
  "Source:",
  "Tags:a b",
  "BeatmapID:123",
  "BeatmapSetID:456",
  "",
  "[Difficulty]",
  "CircleSize:4",
  "",
  "[Events]",
  "",
  "[TimingPoints]",
  "500,300,4,2,0,60,1,0",
  "2500,300,4,2,0,60,1,0",
  "6000,300,4,2,0,60,1,0",
  "9000,300,3,2,0,60,1,0",
  "12000,-100,4,2,0,60,0,0",
  "",
  "[HitObjects]",
  ""
].join("\r\n");
var imp = fromOsu(OSU, TEMPLATE);
console.log(imp.text);
console.log("\u7EA2\u7EBF", imp.timingCount, "\u7EFF\u7EBF", imp.skippedGreen);
var lines = imp.text.split("\n");
T("\u5BFC\u5165\u65E0\u8FDE\u7EED\u7A7A\u884C", !/\n[ \t]*\n[ \t]*\n/.test(imp.text) && imp.text.split("\n\n\n").length === 1);
T("[Metadata] \u6BCF\u9879\u4E00\u884C", lines.filter((l) => /^(Title|Artist|Creator) =/.test(l)).length >= 3);
T("\u7EA2\u7EBF 4 \u6761 / \u7EFF\u7EBF\u5FFD\u7565 1 \u6761", imp.timingCount === 4 && imp.skippedGreen === 1);
T(
  "\u95F4\u8DDD 2000ms \u4E14\u62CD\u53F7\u4E0D\u53D8 => \u7EE7\u627F\uFF08resetBeats=2.666667\uFF09",
  imp.text.includes("2500,300,4,0,2.666667")
);
T("\u95F4\u8DDD 3500ms => \u4E0D\u7EE7\u627F\u62CD\u5B50", imp.text.includes("6000,300,4,1,0"));
T("\u62CD\u53F7\u53D8\u5316 => \u4E0D\u7EE7\u627F\u62CD\u5B50", imp.text.includes("9000,300,3,1,0"));
T("Mode \u6620\u5C04", /Mode = mania/.test(imp.text));
T("audio \u5199\u5165 [Files]", /audio = "audio\.mp3"/.test(imp.text));
T("\u5BFC\u5165\u7ED3\u679C\u53EF\u518D\u89E3\u6790\u4E14\u65E0\u9519\u8BEF", (() => {
  const dd = parseChart(imp.text);
  const errs = dd.diagnostics.filter((x) => x.severity === "error");
  if (errs.length) console.log(errs.map((e) => e.message));
  return errs.length === 0 && dd.timing.length === 4;
})());
console.log("\n=== \u6587\u4EF6\u81EA\u52A8\u5339\u914D ===");
function mkFile(path) {
  const name = path.split(/[\\/]/).pop() || path;
  const f = new File([new Uint8Array([1, 2, 3])], name, { type: "audio/wav" });
  Object.defineProperty(f, "webkitRelativePath", { value: path });
  return f;
}
var pickedA = [
  mkFile("foobar/audio.mp3"),
  mkFile("foobar/hs/Kick.wav"),
  mkFile("foobar/hs/Snare.wav"),
  mkFile("foobar/other/Noise.wav")
];
var pickedB = [mkFile("Songs/foobar/audio.mp3"), mkFile("Songs/foobar/hs/Kick.wav")];
var pickedC = [mkFile("audio.mp3"), mkFile("Kick.wav"), mkFile("Snare.wav")];
var chart = parseChart(
  '[Files]\npath = "E:' + String.fromCharCode(92) + "osu" + String.fromCharCode(92) + "Songs" + String.fromCharCode(92) + 'foobar"\naudio = "audio.mp3"\n\n[Define]\nhitsound custom K = "hs/Kick.wav"\nhitsound custom S = "hs/Snare.wav"\nhitsound custom X = "D:' + String.fromCharCode(92) + "Music" + String.fromCharCode(92) + 'X.wav"\nhitsound custom D = default.normal-hitnormal\n\n[Timing]\n0,bpm(120),4,0,0\n[Hitsound]\n/K/\n'
);
{
  const es = entriesFromFiles(pickedA);
  const song = matchSong(chart, es);
  T("\u9009 foobar\uFF1A\u6B4C\u66F2\u7CBE\u786E\u547D\u4E2D audio.mp3", song.file?.name === "audio.mp3" && song.how === "exact", song.file?.name + "/" + song.how);
  const ms = matchHitsounds(chart, es);
  T("\u9009 foobar\uFF1AK/S \u7CBE\u786E\u547D\u4E2D", ms.length === 3 && ms[0].file?.name === "Kick.wav" && ms[1].file?.name === "Snare.wav", JSON.stringify(ms.map((m) => [m.target.name, m.file?.name, m.how])));
  T("\u9009 foobar\uFF1A\u7EDD\u5BF9\u8DEF\u5F84 X \u672A\u9009\u5219\u843D\u7A7A", ms[2].file === null);
  T("default \u97F3\u6548\u4E0D\u53C2\u4E0E\u5339\u914D", !ms.some((m) => m.target.defaultRef));
}
{
  const es = entriesFromFiles(pickedB);
  const song = matchSong(chart, es);
  T("\u9009\u4E0A\u5C42 Songs\uFF1A\u6B4C\u66F2\u6309\u540E\u7F00\u547D\u4E2D", song.file?.name === "audio.mp3" && song.how === "suffix", song.file?.name + "/" + song.how);
  const ms = matchHitsounds(chart, es);
  T("\u9009\u4E0A\u5C42 Songs\uFF1AK \u547D\u4E2D / S \u843D\u7A7A", ms[0].file?.name === "Kick.wav" && ms[1].file === null, JSON.stringify(ms.map((m) => [m.target.name, m.file?.name])));
}
{
  const es = entriesFromFiles(pickedC);
  const song = matchSong(chart, es);
  T("\u6563\u6587\u4EF6\uFF1A\u6B4C\u66F2\u547D\u4E2D audio.mp3", song.file?.name === "audio.mp3", song.file?.name + "/" + song.how);
  const ms = matchHitsounds(chart, es);
  T("\u6563\u6587\u4EF6\uFF1AK/S \u6309\u6587\u4EF6\u540D\u547D\u4E2D", ms[0].file?.name === "Kick.wav" && ms[1].file?.name === "Snare.wav", JSON.stringify(ms.map((m) => [m.target.name, m.file?.name, m.how])));
}
T("\u76EE\u5F55\u91CC\u6CA1\u6709\u76EE\u6807\u6587\u4EF6\u65F6\u4E0D\u8BEF\u547D\u4E2D", (() => {
  const es = entriesFromFiles([mkFile("nope/unrelated.ogg")]);
  return matchSong(chart, es).file === null && matchHitsounds(chart, es).every((m) => m.file === null);
})());
console.log("\n=== \u53D8 BPM ===");
var bpmChart = parseChart("[Timing]\n0,bpm(120),4,0,0\n2000,bpm(240),4,0,0\n\n[Define]\nhitsound custom K = default.normal-hitnormal\n\n[Hitsound]\n/K K K K/\n/K K K K/\n/K K K K/\n/K K K K/\n/K K K K/\n/K K K K/\n");
{
  const ms = bpmChart.measures;
  const dump = JSON.stringify(ms.slice(0, 4).map((m) => [Math.round(m.start), Math.round(m.end), Math.round(m.beatLength)]));
  T("\u53D8BPM\uFF1A\u5C0F\u82820 = 0~2000\uFF08120BPM 4\u62CD\uFF09", ms.length > 0 && Math.abs(ms[0].start) < 1 && Math.abs(ms[0].end - 2e3) < 1, dump);
  T("\u53D8BPM\uFF1A\u5C0F\u82821 \u4ECE 2000 \u8D77\u4E14 beatLength=250", ms.length > 1 && Math.abs(ms[1].start - 2e3) < 1 && Math.abs(ms[1].beatLength - 250) < 0.01, ms[1] ? "start=" + Math.round(ms[1].start) + " bl=" + ms[1].beatLength.toFixed(1) : "no m1");
  T("\u53D8BPM\uFF1A\u5C0F\u82821 \u957F\u5EA6 1000\uFF08240BPM 4\u62CD\uFF09", ms.length > 1 && Math.abs(ms[1].end - ms[1].start - 1e3) < 1, ms[1] ? "len=" + Math.round(ms[1].end - ms[1].start) : "");
  const beats = ms.flatMap((m) => measureBeatTimes(m)).sort((a, b) => a - b);
  const early = beats.filter((t) => t >= 0 && t < 2e3);
  const late = beats.filter((t) => t >= 2e3 && t < 4e3);
  const gapEarly = early.length > 1 ? early[1] - early[0] : -1;
  const gapLate = late.length > 1 ? late[1] - late[0] : -1;
  T("\u53D8BPM\uFF1A\u6162\u6BB5\u62CD\u95F4\u9694 500ms", Math.abs(gapEarly - 500) < 1, "gap=" + gapEarly);
  T("\u53D8BPM\uFF1A\u5FEB\u6BB5\u62CD\u95F4\u9694 250ms\uFF08\u523B\u5EA6\u53D8\u5BC6\uFF09", Math.abs(gapLate - 250) < 1, "gap=" + gapLate);
  T("\u53D8BPM\uFF1A\u4E0D\u662F\u6052\u5B9A BPM", Math.abs(gapEarly - gapLate) > 1, gapEarly + " vs " + gapLate);
  const ticks = ms.flatMap((m) => measureTicks(m, 4)).sort((a, b) => a - b);
  const tEarly = ticks.filter((t) => t >= 0 && t < 2e3);
  const tLate = ticks.filter((t) => t >= 2e3 && t < 3e3);
  T("\u53D8BPM\uFF1A1/4 \u523B\u5EA6\u6162\u6BB5\u95F4\u9694 125ms", tEarly.length > 1 && Math.abs(tEarly[1] - tEarly[0] - 125) < 1, String(tEarly.length > 1 ? tEarly[1] - tEarly[0] : -1));
  T("\u53D8BPM\uFF1A1/4 \u523B\u5EA6\u5FEB\u6BB5\u95F4\u9694 62.5ms", tLate.length > 1 && Math.abs(tLate[1] - tLate[0] - 62.5) < 1, String(tLate.length > 1 ? tLate[1] - tLate[0] : -1));
}
var midChart = parseChart("[Timing]\n0,bpm(120),4,0,0\n1000,bpm(240),4,0,2\n\n[Define]\nhitsound custom K = default.normal-hitnormal\n\n[Hitsound]\n/K K K K/\n/K K K K/\n");
{
  const m0 = midChart.measures[0];
  T("\u5C0F\u8282\u5185\u53D8\u901F\uFF1A\u957F\u5EA6 = 2*500 + 2*250 = 1500", !!m0 && Math.abs(m0.end - m0.start - 1500) < 1, m0 ? "len=" + Math.round(m0.end - m0.start) : "");
  T("\u5C0F\u8282\u5185\u53D8\u901F\uFF1A\u62C6\u6210 2 \u6BB5", !!(m0 && m0.segments && m0.segments.length === 2), JSON.stringify(m0 && m0.segments ? m0.segments.map((s) => [Math.round(s.start), Math.round(s.end), Math.round(s.beatLength), s.beats]) : null));
  const beats = m0 ? measureBeatTimes(m0) : [];
  T("\u5C0F\u8282\u5185\u53D8\u901F\uFF1A\u62CD\u70B9 0/500/1000/1250", beats.length === 4 && Math.abs(beats[1] - 500) < 1 && Math.abs(beats[3] - 1250) < 1, JSON.stringify(beats.map((b) => Math.round(b))));
  T("\u5C0F\u8282\u5185\u53D8\u901F\uFF1AbeatAt(1250) = 3", !!m0 && Math.abs(beatAt(m0, 1250) - 3) < 0.01, m0 ? String(beatAt(m0, 1250)) : "");
}
var lazyChart = parseChart("[Timing]\n0,bpm(120),4,0,0\n40000,bpm(240),4,0,0\n\n[Define]\nhitsound custom K = default.normal-hitnormal\n\n[Hitsound]\n/K K K K/\n/K K K K/\n");
{
  T("\u7F51\u683C\uFF1A\u6B63\u6587\u53EA\u7528 2 \u5C0F\u8282", lazyChart.usedMeasures === 2, "used=" + lazyChart.usedMeasures);
  const ms = lazyChart.measures;
  T("\u7F51\u683C\uFF1A\u94FA\u5230\u8FDC\u8D85\u6B63\u6587\u8303\u56F4\uFF08>2 \u5C0F\u8282\uFF09", ms.length > 2, "grid=" + ms.length);
  const reaches = ms.some((m) => m.start <= 4e4 && m.end > 4e4);
  T("\u7F51\u683C\uFF1A\u8986\u76D6\u5230 40s \u7684\u53D8\u901F\u70B9", reaches, "lastEnd=" + Math.round(ms[ms.length - 1].end));
  const after = ms.filter((m) => m.start >= 4e4);
  T("\u7F51\u683C\uFF1A\u53D8\u901F\u70B9\u4E4B\u540E\u4ECD\u6709\u82E5\u5E72\u5C0F\u8282", after.length >= 8, "after=" + after.length);
  T("\u7F51\u683C\uFF1A\u53D8\u901F\u540E beatLength \u53D8 250", after.length > 0 && Math.abs(after[0].beatLength - 250) < 0.01, after.length ? String(after[0].beatLength) : "none");
}
var emptyBody = parseChart("[Timing]\n0,bpm(120),4,0,0\n\n[Define]\nhitsound custom K = default.normal-hitnormal\n\n[Hitsound]\n");
{
  T("\u7F51\u683C\uFF1A\u7A7A\u6B63\u6587\u4E5F\u6709 >=32 \u5C0F\u8282", emptyBody.measures.length >= 32, "grid=" + emptyBody.measures.length);
  T("\u7F51\u683C\uFF1A\u7A7A\u6B63\u6587 usedMeasures=0", emptyBody.usedMeasures === 0, "used=" + emptyBody.usedMeasures);
}
var slowChart = parseChart("[Timing]\n0,bpm(120),4,0,0\n2000,bpm(60),4,0,0\n\n[Define]\nhitsound custom K = default.normal-hitnormal\n\n[Hitsound]\n/K K K K/\n/K K K K/\n/K K K K/\n/K K K K/\n");
{
  const ms = slowChart.measures;
  const beats = ms.flatMap((m) => measureBeatTimes(m)).sort((a, b) => a - b);
  const late = beats.filter((t) => t >= 2e3 && t < 6e3);
  T("\u53D8BPM\uFF1A\u53D8\u6162\u540E\u62CD\u95F4\u9694 1000ms\uFF08\u523B\u5EA6\u53D8\u758F\uFF09", late.length > 1 && Math.abs(late[1] - late[0] - 1e3) < 1, late.length > 1 ? String(late[1] - late[0]) : "no beats");
}
console.log("\n=== \u7EAF\u6570\u5B57\u5C0F\u8282 /5/ ===");
var DEF = "[Define]\nhitsound custom K = default.normal-hitnormal\n\n";
var T120 = "[Timing]\n0,bpm(120),4,0,0\n\n";
var H = (body) => parseChart(T120 + DEF + "[Hitsound]\n" + body);
{
  const a = H("/5/K K K K/");
  const b = H("/////K K K K/");
  const spanOf = (c2) => {
    const ts = c2.events.map((e2) => e2.time);
    return ts.length ? Math.max(...ts) - Math.min(...ts) : -1;
  };
  T("/5/\uFF1A4 \u4E2A\u97F3\u7B26\u644A\u5728 5 \u4E2A\u5C0F\u8282\u5185\uFF08\u603B\u8DE8\u5EA6 7500ms\uFF09", a.events.length === 4 && Math.abs(spanOf(a) - 7500) < 1, "n=" + a.events.length + " span=" + spanOf(a));
  T("/5/ \u4E0E ///// \u7B49\u4EF7", a.events.length === b.events.length && Math.abs(spanOf(a) - spanOf(b)) < 1, "a=" + spanOf(a) + " b=" + spanOf(b));
  T("/5/\uFF1AusedMeasures = 5", a.usedMeasures === 5, "used=" + a.usedMeasures);
  T("/5/\uFF1A\u6570\u5B57\u4E0D\u88AB\u5F53\u97F3\u7B26\uFF08\u6CA1\u6709\u540D\u4E3A 5 \u7684\u4E8B\u4EF6\uFF09", !a.events.some((e2) => e2.names.includes("5")), JSON.stringify(a.events.map((e2) => e2.names)));
  T("/5/\uFF1AK \u8D77\u59CB\u65F6\u95F4 = 0\uFF08\u7B2C 1 \u4E2A\u5C0F\u8282\u5F00\u5934\uFF09", a.events.length > 0 && Math.abs(a.events[0].time) < 1, a.events.length ? String(a.events[0].time) : "");
  const c = H("/=/K K K K/");
  T("/=/ \u4ECD\u662F\u7A7A\u5C0F\u8282\uFF08\u97F3\u7B26\u4ECE\u7B2C 2 \u5C0F\u8282\u5F00\u59CB\uFF09", c.events.length === 4 && Math.abs(c.events[0].time - 2e3) < 1, c.events.length ? String(c.events[0].time) : "");
  const d = H("/5K K K K/");
  T("/5K.../ \u91CC\u7684 5 \u662F\u97F3\u6548\u7EC4\u7F16\u53F7", d.events.length === 4 && d.events.every((e2) => e2.index === 5), JSON.stringify(d.events.map((e2) => e2.index)));
  const e = H("/2/K K/");
  T("/2/\uFF1A2 \u4E2A\u97F3\u7B26\u644A\u5728 2 \u4E2A\u5C0F\u8282\uFF08\u9996\u97F3 0\u3001\u6B21\u97F3 2000\uFF09", e.events.length === 2 && Math.abs(e.events[0].time) < 1 && Math.abs(e.events[1].time - 2e3) < 1, JSON.stringify(e.events.map((x) => Math.round(x.time))));
  const f = H("/0/K/");
  T("/0/ \u62A5\u9519\u8BEF\u8BCA\u65AD", f.diagnostics.some((x) => x.code === "span-bad" && x.severity === "error"), JSON.stringify(f.diagnostics.map((x) => x.code)));
}
console.log("\n=== \u6BB5\u843D\u6807\u8BB0 # ===");
var MARK = parseChart(
  "[Settings]\nBookmarks = {114514, 1919810}\n\n" + T120 + DEF + "[Hitsound]\n#123456\n#2:03.456\n#02:03.456\n#2:03:456\n#02:03:456\n#bookmark(0)\n#bookmark(1)\n#timing(0)\n/K/\n"
);
{
  const ms = MARK.markers;
  T("\u6BB5\u843D\u6807\u8BB0\uFF1A\u5171\u89E3\u6790\u51FA 8 \u4E2A", ms.length === 8, "n=" + ms.length);
  const t = (i) => ms[i] ? ms[i].time : null;
  T("#123456 = 123456ms", t(0) === 123456, String(t(0)));
  T("#2:03.456 = 123456ms", t(1) === 123456, String(t(1)));
  T("#02:03.456 = 123456ms", t(2) === 123456, String(t(2)));
  T("#2:03:456 = 123456ms", t(3) === 123456, String(t(3)));
  T("#02:03:456 = 123456ms", t(4) === 123456, String(t(4)));
  T("#bookmark(0) = Bookmarks[0] = 114514", t(5) === 114514, String(t(5)));
  T("#bookmark(1) = Bookmarks[1] = 1919810", t(6) === 1919810, String(t(6)));
  T("#timing(0) = 0", t(7) === 0, String(t(7)));
  T("\u6BB5\u843D\u6807\u8BB0\uFF1A\u5168\u90E8\u89E3\u6790\u6210\u529F\uFF08\u65E0 null\uFF09", ms.every((m) => m.time !== null && m.measure !== null), JSON.stringify(ms.map((m) => [m.raw, m.time])));
  T("\u6807\u8BB0\u540E\u7684\u97F3\u7B26\u4ECE\u6807\u8BB0\u5904\u7EE7\u7EED", MARK.events.length === 1 && Math.abs(MARK.events[0].time) < 1, JSON.stringify(MARK.events.map((e) => Math.round(e.time))));
}
{
  const c = parseChart(T120 + DEF + "[Hitsound]\n## \u8FD9\u662F\u6CE8\u91CA\n/K K K K/\n");
  T("## \u4ECD\u662F\u6CE8\u91CA\uFF08\u4E0D\u4EA7\u751F\u6807\u8BB0\u3001\u4E0D\u62A5\u9519\uFF09", c.markers.length === 0 && c.events.length === 4, "markers=" + c.markers.length + " events=" + c.events.length);
  const bad = parseChart(T120 + DEF + "[Hitsound]\n#bookmark(9)\n/K/\n");
  T("#bookmark \u8D8A\u754C\u62A5\u9519", bad.diagnostics.some((d) => d.code === "marker-bad"), JSON.stringify(bad.diagnostics.map((d) => d.message)));
  const bad2 = parseChart(T120 + DEF + "[Hitsound]\n#timing(3)\n/K/\n");
  T("#timing \u8D8A\u754C\u62A5\u9519", bad2.diagnostics.some((d) => d.code === "marker-bad"));
  const bad3 = parseChart(T120 + DEF + "[Hitsound]\n#abc\n/K/\n");
  T("#abc \u65E0\u6CD5\u8BC6\u522B\u65F6\u62A5\u9519", bad3.diagnostics.some((d) => d.code === "marker-bad"));
}
console.log("\n=== Bookmarks ===");
{
  const c = parseChart("[Settings]\nBookmarks={114514,1919810}\n\n" + T120 + DEF + "[Hitsound]\n/K/\n");
  T("Bookmarks \u89E3\u6790\u4E3A\u6570\u5B57\u6570\u7EC4", c.settings.Bookmarks.length === 2 && c.settings.Bookmarks[0] === 114514 && c.settings.Bookmarks[1] === 1919810, JSON.stringify(c.settings.Bookmarks));
  T("\u7A7A Bookmarks \u4E0D\u62A5\u9519", (() => {
    const e = parseChart("[Settings]\nBookmarks={}\n\n" + T120 + DEF + "[Hitsound]\n/K/\n");
    return e.settings.Bookmarks.length === 0;
  })());
  T("Bookmarks \u91CC\u975E\u6570\u5B57\u62A5\u9519", (() => {
    const e = parseChart("[Settings]\nBookmarks={abc}\n\n" + T120 + DEF + "[Hitsound]\n/K/\n");
    return e.diagnostics.some((d) => d.code === "set-bookmarks");
  })());
}
console.log("\n=== \u7F51\u683C\u94FA\u5230\u6B4C\u66F2\u7ED3\u675F ===");
{
  const body = T120 + DEF + "[Hitsound]\n/K K K K/\n";
  const noAudio = parseChart(body);
  const withAudio = parseChart(body, { audioDurationMs: 18e4 });
  T("\u65E0\u97F3\u9891\uFF1A\u7F51\u683C\u53EA\u94FA\u4FDD\u5E95\u7684 32 \u5C0F\u8282", noAudio.measures.length === 32, "grid=" + noAudio.measures.length);
  T("\u6709\u97F3\u9891\uFF08180s\uFF09\uFF1A\u7F51\u683C\u94FA\u8FC7\u6B4C\u66F2\u7ED3\u675F", withAudio.measures.length > 32 && withAudio.measures[withAudio.measures.length - 1].end >= 18e4, "grid=" + withAudio.measures.length + " lastEnd=" + Math.round(withAudio.measures[withAudio.measures.length - 1].end));
  T("\u6709\u97F3\u9891\uFF1A\u7F51\u683C\u672B\u5C3E\u6070\u597D\u8986\u76D6\u6B4C\u66F2\u957F\u5EA6\uFF08\u4E0D\u65E0\u9650\u94FA\uFF09", withAudio.measures[withAudio.measures.length - 1].end - 2e3 < 18e4, "lastEnd=" + Math.round(withAudio.measures[withAudio.measures.length - 1].end));
}
console.log("\n=== .osu Bookmarks \u5F80\u8FD4 ===");
{
  const osu = [
    "osu file format v14",
    "",
    "[General]",
    "AudioFilename: audio.mp3",
    "Mode: 0",
    "",
    "[Editor]",
    "DistanceSpacing: 1",
    "BeatDivisor: 4",
    "Bookmarks: 114514,1919810",
    "",
    "[Metadata]",
    "Title:Test",
    "Artist:Foo",
    "",
    "[TimingPoints]",
    "500,333.333333333333,4,2,1,60,1,0",
    ""
  ].join("\n");
  const imp2 = fromOsu(osu, TEMPLATE);
  T("\u5BFC\u5165\uFF1ABookmarks \u6570\u91CF = 2", imp2.bookmarksCount === 2, "n=" + imp2.bookmarksCount);
  T("\u5BFC\u5165\uFF1A\u5199\u5165 [Settings] Bookmarks", /Bookmarks\s*=\s*\{114514,\s*1919810\}/.test(imp2.text), (imp2.text.match(/Bookmarks.*/) || [""])[0]);
  const re = parseChart(imp2.text);
  T("\u5BFC\u5165\uFF1A\u518D\u89E3\u6790\u5F97\u5230 2 \u4E2A\u4E66\u7B7E", re.settings.Bookmarks.length === 2, JSON.stringify(re.settings.Bookmarks));
  T("\u5BFC\u5165\uFF1A\u7ED3\u679C\u65E0 error \u8BCA\u65AD", !re.diagnostics.some((d) => d.severity === "error"), JSON.stringify(re.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)));
  const out = toOsu(re);
  T("\u5BFC\u51FA\uFF1A[Editor] \u5199\u51FA Bookmarks", /Bookmarks:\s*114514,1919810/.test(out), (out.match(/Bookmarks:.*/) || [""])[0]);
  const none = fromOsu("[General]\nAudioFilename: a.mp3\n\n[Editor]\nBeatDivisor: 4\n\n[Metadata]\nTitle:T\n\n[TimingPoints]\n0,500,4,2,1,60,1,0\n", TEMPLATE);
  T("\u5BFC\u5165\uFF1A\u6CA1\u6709 Bookmarks \u65F6\u4E0D\u5199\u8BE5\u9879", none.bookmarksCount === 0 && !/Bookmarks\s*=\s*\{\s*\d/.test(none.text), "n=" + none.bookmarksCount);
}
{
  console.log("\n=== Keysound ===");
  T("\u97F3\u9AD8\uFF1AA4 = 69", midiOf("A", 4) === 69, String(midiOf("A", 4)));
  T("\u97F3\u9AD8\uFF1AA0 = 21\uFF08\u94A2\u7434\u6700\u4F4E\u97F3\uFF09", midiOf("A", 0) === 21, String(midiOf("A", 0)));
  T("\u97F3\u9AD8\uFF1AC8 = 108\uFF08\u94A2\u7434\u6700\u9AD8\u97F3\uFF09", midiOf("C", 8) === 108, String(midiOf("C", 8)));
  T("\u97F3\u9AD8\uFF1AmidiToName(69) = A4", midiToName(69) === "A4", midiToName(69));
  T("\u97F3\u9AD8\uFF1AmidiToName(21) = A0", midiToName(21) === "A0", midiToName(21));
  T('\u97F3\u9AD8\uFF1AnameToMidi("C8") = 108', nameToMidi("C8") === 108, String(nameToMidi("C8")));
  T("\u97F3\u9AD8\uFF1AA4 = 440Hz", Math.abs(freqOf(69) - 440) < 1e-3, freqOf(69).toFixed(3));
  T("\u97F3\u9AD8\uFF1AA3 = 220Hz", Math.abs(freqOf(57) - 220) < 1e-3, freqOf(57).toFixed(3));
  T("\u97F3\u9AD8\uFF1AH(=C#) \u662F\u9ED1\u952E\uFF0CC \u4E0D\u662F", isBlackKey(midiOf("H", 4)) && !isBlackKey(midiOf("C", 4)));
  T("\u97F3\u9AD8\uFF1A\u4E00\u4E2A\u516B\u5EA6 12 \u4E2A\u534A\u97F3", letterToSemi("B") === 11 && letterToSemi("C") === 0);
  const pan = unquote('"piano/<loop("A","L","B","C","H","D","I","E","F","J","G","K")><int((i+9)/12)>.wav"');
  const exp = expandKeysoundPath({
    pattern: pan,
    low: nameToMidi("A0"),
    high: nameToMidi("C8"),
    tune: 0,
    lists: /* @__PURE__ */ new Map()
  });
  T("\u6A21\u677F\uFF1A\u5C55\u5F00 88 \u4E2A\u97F3\u9AD8", exp.files.size === 88, String(exp.files.size));
  T("\u6A21\u677F\uFF1AMIDI 21 -> piano/A0.wav", String(exp.files.get(21)).endsWith("piano/A0.wav"), String(exp.files.get(21)));
  T("\u6A21\u677F\uFF1AMIDI 60 -> piano/C4.wav", String(exp.files.get(60)).endsWith("piano/C4.wav"), String(exp.files.get(60)));
  T("\u6A21\u677F\uFF1AMIDI 108 -> piano/C8.wav", String(exp.files.get(108)).endsWith("piano/C8.wav"), String(exp.files.get(108)));
  T("\u6A21\u677F\uFF1A\u65E0\u5C55\u5F00\u9519\u8BEF", exp.errors.length === 0, exp.errors.join(";"));
  const pad = expandKeysoundPath({ pattern: "<int(m,3)>.wav", low: 60, high: 62, tune: 0, lists: /* @__PURE__ */ new Map() });
  T("\u6A21\u677F\uFF1Aint \u7B2C\u4E8C\u53C2\u6570\u8865\u96F6", pad.files.get(60) === "060.wav", String(pad.files.get(60)));
  const byList = expandKeysoundPath({
    pattern: "<list(PN)><int(i/12)>.wav",
    low: 60,
    high: 61,
    tune: 0,
    lists: /* @__PURE__ */ new Map([["PN", ["C", "H", "D"]]])
  });
  T("\u6A21\u677F\uFF1Alist() \u5FAA\u73AF\u53D6\u503C", byList.files.get(60) === "C0.wav" && byList.files.get(61) === "H0.wav", String(byList.files.get(60)) + "/" + String(byList.files.get(61)));
  const ks = parseChart(
    [
      "[Files]",
      'path = "D:/song"',
      'audio = "a.mp3"',
      "",
      "[Define]",
      "hitsound custom D = default.normal-hitnormal",
      'keysound custom piano = ("piano/<loop("A","L","B","C","H","D","I","E","F","J","G","K")><int((i+9)/12)>.wav", A0, C8)',
      "",
      "[Timing]",
      "0,bpm(120),4,0,0",
      "",
      "[Keysound]",
      "{piano}",
      "/4C D E F/",
      "/^G _C/",
      "/4A/",
      "",
      "[Hitsound]",
      "/D D D D/",
      ""
    ].join("\n")
  );
  const kes = ks.events.filter((e) => e.kind === "keysound");
  const pitches = kes.map((e) => e.pitch);
  console.log("keysound \u97F3\u7B26\uFF1A" + kes.map((e) => e.names[0] + "(" + e.pitch + ")").join(" "));
  T(
    "\u6B63\u6587\uFF1A\u4E50\u5668\u5217\u8868\u89E3\u6790\u51FA 1 \u6761\u8C31\u8868 piano",
    ks.keyInstruments.length === 1 && ks.keyInstruments[0].name === "piano",
    JSON.stringify(ks.keyInstruments.map((i) => i.name))
  );
  T("\u6B63\u6587\uFF1Akeysound \u97F3\u7B26\u6570 = 7", kes.length === 7, String(kes.length));
  T(
    "\u6B63\u6587\uFF1A/4C D E F/ -> C4 D4 E4 F4",
    JSON.stringify(pitches.slice(0, 4)) === JSON.stringify([60, 62, 64, 65]),
    JSON.stringify(pitches.slice(0, 4))
  );
  T("\u6B63\u6587\uFF1A^G \u843D\u5728\u4E0A\u4E00\u4E2A\u97F3 +1~+12 \u5185\uFF08G4=67\uFF09", pitches[4] === 67, String(pitches[4]));
  T("\u6B63\u6587\uFF1A_C \u843D\u5728\u4E0A\u4E00\u4E2A\u97F3 -12~-1 \u5185\uFF08C4=60\uFF09", pitches[5] === 60, String(pitches[5]));
  T("\u6B63\u6587\uFF1A/4A/ \u7EDD\u5BF9\u516B\u5EA6 -> A4=69", pitches[6] === 69, String(pitches[6]));
  T("\u6B63\u6587\uFF1A\u4E50\u5668\u540D\u5199\u5230\u4E8B\u4EF6\u4E0A", kes.every((e) => e.instrument === "piano"), String(kes[0] && kes[0].instrument));
  const pno = ks.hitsounds.find((h) => h.kind === "keysound" && h.name === "piano");
  T("\u6B63\u6587\uFF1Apiano \u5C55\u5F00\u51FA 88 \u4E2A\u97F3\u9AD8\u7684\u6587\u4EF6\u8868", (pno && pno.keyFiles && pno.keyFiles.size) === 88, String(pno && pno.keyFiles && pno.keyFiles.size));
  T(
    "\u6B63\u6587\uFF1Ahitsound \u97F3\u7B26\u4ECD\u5728\u540C\u4E00\u4E2A events \u91CC",
    ks.events.filter((e) => e.kind === "hitsound").length === 4,
    String(ks.events.filter((e) => e.kind === "hitsound").length)
  );
  T(
    "\u6B63\u6587\uFF1A\u65E0 error \u8BCA\u65AD",
    !ks.diagnostics.some((d) => d.severity === "error"),
    JSON.stringify(ks.diagnostics.filter((d) => d.severity === "error").map((d) => d.message))
  );
  const dur = parseChart(
    [
      "[Timing]",
      "0,bpm(120),4,0,0",
      "",
      "[Define]",
      'keysound custom piano = ("x.wav", C4, C4)',
      "",
      "[Keysound]",
      "{piano}",
      "/4C4/",
      ""
    ].join("\n")
  );
  const dn = dur.events.filter((e) => e.kind === "keysound");
  T("\u65F6\u503C\uFF1A/4C4/ \u53EA\u4EA7\u751F 1 \u4E2A\u97F3\u7B26\uFF08\u540E\u9762\u7684 4 \u662F\u65F6\u503C\uFF09", dn.length === 1, String(dn.length));
  T("\u65F6\u503C\uFF1A\u8BE5\u97F3\u7B26\u5360\u6EE1\u6574\u5C0F\u8282 2000ms", dn.length === 1 && Math.abs(dn[0].duration - 2e3) < 1, String(dn[0] && dn[0].duration));
  const multi = parseChart(
    [
      "[Timing]",
      "0,bpm(120),4,0,0",
      "",
      "[Define]",
      'keysound custom piano = ("x.wav", C4, C4)',
      "",
      "[Keysound]",
      "{piano}",
      "/4C | 3C/",
      ""
    ].join("\n")
  );
  const ms = multi.events.filter((e) => e.kind === "keysound");
  T(
    "\u591A\u8C31\u8868\uFF1A\u4E24\u4E2A\u97F3\u540C\u65F6\u5F00\u59CB\u3001\u516B\u5EA6\u4E92\u4E0D\u5E72\u6270\uFF08C4=60 / C3=48\uFF09",
    ms.length === 2 && ms.every((e) => e.time === ms[0].time) && ms.some((e) => e.pitch === 60) && ms.some((e) => e.pitch === 48),
    JSON.stringify(ms.map((e) => [e.staff, e.pitch]))
  );
  const bad = parseChart("[Timing]\n0,bpm(120),4,0,0\n\n[Keysound]\n{piano}\n/4Q/\n");
  T("\u8BCA\u65AD\uFF1A\u975E\u6CD5\u97F3\u7B26\u4EE3\u53F7 Q \u62A5\u9519", bad.diagnostics.some((d) => d.code === "ks-note"), JSON.stringify(bad.diagnostics.map((d) => d.code)));
  const badInst = parseChart("[Timing]\n0,bpm(120),4,0,0\n\n[Keysound]\n{nope}\n/4C/\n");
  T("\u8BCA\u65AD\uFF1A\u672A\u5B9A\u4E49\u7684\u4E50\u5668\u62A5\u9519", badInst.diagnostics.some((d) => d.code === "ks-undefined"), JSON.stringify(badInst.diagnostics.map((d) => d.code)));
  const badHead = parseChart("[Timing]\n0,bpm(120),4,0,0\n\n[Keysound]\n/4C/\n");
  T("\u8BCA\u65AD\uFF1A\u7F3A\u5C11\u82B1\u62EC\u53F7\u4E50\u5668\u5217\u8868\u62A5\u9519", badHead.diagnostics.some((d) => d.code === "ks-instbad"), JSON.stringify(badHead.diagnostics.map((d) => d.code)));
  const badCaret = parseChart(
    "[Timing]\n0,bpm(120),4,0,0\n\n[Define]\nhitsound custom D = default.normal-hitnormal\n\n[Hitsound]\n/^D/\n"
  );
  T("\u8BCA\u65AD\uFF1A[Hitsound] \u91CC\u51FA\u73B0 ^ \u62A5\u9519", badCaret.diagnostics.some((d) => d.code === "oct-outside"), JSON.stringify(badCaret.diagnostics.map((d) => d.code)));
}
