// Joins MP4 clips into one MP4 without re-encoding.
//
// It reads each clip's sample tables (regular MP4 or fragmented MP4, which is what
// iPhone Safari's MediaRecorder writes), writes one new `moov` that lists every
// sample from every clip, and points it at the clips' original media bytes.
// The output Blob is made of slices of the input Blobs, so nothing big is copied
// into memory and it takes well under a second, even for an hour of clips.

const MOVIE_TIMESCALE = 1000;

// ---------- reading ----------

function fourcc(u8, p) {
  return String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
}

class Reader {
  constructor(u8, pos = 0) {
    this.u8 = u8;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.p = pos;
  }
  u8_() { return this.u8[this.p++]; }
  u16() { const v = this.dv.getUint16(this.p); this.p += 2; return v; }
  i16() { const v = this.dv.getInt16(this.p); this.p += 2; return v; }
  u32() { const v = this.dv.getUint32(this.p); this.p += 4; return v; }
  i32() { const v = this.dv.getInt32(this.p); this.p += 4; return v; }
  u64() { const hi = this.u32(); const lo = this.u32(); return hi * 2 ** 32 + lo; }
  i64() { const hi = this.i32(); const lo = this.u32(); return hi * 2 ** 32 + lo; }
  bytes(n) { const b = this.u8.subarray(this.p, this.p + n); this.p += n; return b; }
  skip(n) { this.p += n; }
}

// Child boxes of u8[from, to): [{ type, s (box start), d (payload start), e (end) }]
function kids(u8, from = 0, to = u8.length) {
  const out = [];
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = from;
  while (p + 8 <= to) {
    let size = dv.getUint32(p);
    const type = fourcc(u8, p + 4);
    let hdr = 8;
    if (size === 1) { size = dv.getUint32(p + 8) * 2 ** 32 + dv.getUint32(p + 12); hdr = 16; }
    else if (size === 0) size = to - p;
    if (size < hdr || p + size > to) break;
    out.push({ type, s: p, d: p + hdr, e: p + size });
    p += size;
  }
  return out;
}

function child(u8, box, type) {
  return kids(u8, box.d, box.e).find((b) => b.type === type);
}

function path(u8, box, ...types) {
  let b = box;
  for (const t of types) { if (!b) return undefined; b = child(u8, b, t); }
  return b;
}

async function readBytes(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

// Top-level boxes of a Blob, reading only their headers.
async function topBoxes(blob) {
  const out = [];
  let p = 0;
  while (p + 8 <= blob.size) {
    const h = await readBytes(blob, p, Math.min(p + 16, blob.size));
    const dv = new DataView(h.buffer);
    let size = dv.getUint32(0);
    const type = fourcc(h, 4);
    let hdr = 8;
    if (size === 1) { size = dv.getUint32(8) * 2 ** 32 + dv.getUint32(12); hdr = 16; }
    else if (size === 0) size = blob.size - p;
    if (size < hdr) break;
    out.push({ type, s: p, d: p + hdr, e: Math.min(p + size, blob.size) });
    p += size;
  }
  return out;
}

function parseTrak(u8, trak) {
  const t = { samples: [] };
  const tkhd = child(u8, trak, 'tkhd');
  {
    const r = new Reader(u8, tkhd.d);
    const v = r.u32() >>> 24;
    if (v === 1) { r.skip(16); t.id = r.u32(); r.skip(4 + 8); } else { r.skip(8); t.id = r.u32(); r.skip(4 + 4); }
    r.skip(8);
    t.layer = r.i16(); t.altGroup = r.i16(); t.volume = r.i16(); r.skip(2);
    t.matrix = r.bytes(36).slice();
    t.width = r.u32(); t.height = r.u32();
  }
  const mdia = child(u8, trak, 'mdia');
  {
    const r = new Reader(u8, child(u8, mdia, 'mdhd').d);
    const v = r.u32() >>> 24;
    if (v === 1) { r.skip(16); t.timescale = r.u32(); r.skip(8); } else { r.skip(8); t.timescale = r.u32(); r.skip(4); }
    t.language = r.u16();
  }
  const hdlr = child(u8, mdia, 'hdlr');
  t.handler = fourcc(u8, hdlr.d + 8);
  t.hdlrBox = u8.slice(hdlr.s, hdlr.e);
  const minf = child(u8, mdia, 'minf');
  const mhd = kids(u8, minf.d, minf.e).find((b) => /^(vmhd|smhd|nmhd|sthd|gmhd)$/.test(b.type));
  t.mhdBox = mhd ? u8.slice(mhd.s, mhd.e) : null;
  const dinf = child(u8, minf, 'dinf');
  t.dinfBox = dinf ? u8.slice(dinf.s, dinf.e) : null;

  const stbl = child(u8, minf, 'stbl');
  const stsd = child(u8, stbl, 'stsd');
  t.entries = kids(u8, stsd.d + 8, stsd.e).map((b) => u8.slice(b.s, b.e));

  readSampleTable(u8, stbl, t);
  return t;
}

// Regular (non-fragmented) MP4 sample tables.
function readSampleTable(u8, stbl, t) {
  const get = (type) => child(u8, stbl, type);
  const stsz = get('stsz');
  if (!stsz) return;
  let r = new Reader(u8, stsz.d + 4);
  const fixed = r.u32();
  const count = r.u32();
  if (!count) return;
  const sizes = new Array(count);
  for (let i = 0; i < count; i++) sizes[i] = fixed || r.u32();

  const durs = new Array(count).fill(0);
  const stts = get('stts');
  if (stts) {
    r = new Reader(u8, stts.d + 4);
    let n = r.u32(), i = 0;
    while (n-- && i < count) { let c = r.u32(); const d = r.u32(); while (c-- && i < count) durs[i++] = d; }
  }
  const ctos = new Array(count).fill(0);
  const ctts = get('ctts');
  if (ctts) {
    r = new Reader(u8, ctts.d + 4);
    let n = r.u32(), i = 0;
    while (n-- && i < count) { let c = r.u32(); const o = r.i32(); while (c-- && i < count) ctos[i++] = o; }
  }
  let sync = null;
  const stss = get('stss');
  if (stss) {
    sync = new Array(count).fill(false);
    r = new Reader(u8, stss.d + 4);
    let n = r.u32();
    while (n--) { const k = r.u32() - 1; if (k >= 0 && k < count) sync[k] = true; }
  }
  const chunkOffs = [];
  const stco = get('stco'), co64 = get('co64');
  if (stco) { r = new Reader(u8, stco.d + 4); let n = r.u32(); while (n--) chunkOffs.push(r.u32()); }
  else if (co64) { r = new Reader(u8, co64.d + 4); let n = r.u32(); while (n--) chunkOffs.push(r.u64()); }
  const stscE = [];
  const stsc = get('stsc');
  if (stsc) { r = new Reader(u8, stsc.d + 4); let n = r.u32(); while (n--) stscE.push([r.u32(), r.u32(), r.u32()]); }

  let i = 0;
  for (let e = 0; e < stscE.length && i < count; e++) {
    const [first, perChunk, sdi] = stscE[e];
    const last = e + 1 < stscE.length ? stscE[e + 1][0] - 1 : chunkOffs.length;
    for (let c = first; c <= last && i < count; c++) {
      let off = chunkOffs[c - 1];
      for (let k = 0; k < perChunk && i < count; k++, i++) {
        t.samples.push({ off, size: sizes[i], dur: durs[i], cto: ctos[i], sync: sync ? sync[i] : true, sdi });
        off += sizes[i];
      }
    }
  }
}

// Fragmented MP4: one moof box.
function readMoof(u8, moofStart, byId, trex) {
  const moof = { d: 8, e: u8.length };
  if (new DataView(u8.buffer, u8.byteOffset).getUint32(0) === 1) moof.d = 16;
  let prevEnd = moofStart;
  let first = true;
  for (const traf of kids(u8, moof.d, moof.e)) {
    if (traf.type !== 'traf') continue;
    const tk = kids(u8, traf.d, traf.e);
    const tfhd = tk.find((b) => b.type === 'tfhd');
    if (!tfhd) continue;
    const r = new Reader(u8, tfhd.d);
    const flags = r.u32() & 0xffffff;
    const id = r.u32();
    const def = trex[id] || { sdi: 1, dur: 0, size: 0, flags: 0 };
    let base;
    if (flags & 0x1) base = r.u64();
    else if (flags & 0x20000) base = moofStart;
    else base = first ? moofStart : prevEnd;
    const sdi = flags & 0x2 ? r.u32() : def.sdi;
    const dDur = flags & 0x8 ? r.u32() : def.dur;
    const dSize = flags & 0x10 ? r.u32() : def.size;
    const dFlags = flags & 0x20 ? r.u32() : def.flags;
    first = false;
    const t = byId[id];
    let pos = base;
    for (const trun of tk) {
      if (trun.type !== 'trun') continue;
      const q = new Reader(u8, trun.d);
      const vf = q.u32();
      const f = vf & 0xffffff;
      const count = q.u32();
      if (f & 0x1) pos = base + q.i32();
      const firstFlags = f & 0x4 ? q.u32() : null;
      for (let i = 0; i < count; i++) {
        const dur = f & 0x100 ? q.u32() : dDur;
        const size = f & 0x200 ? q.u32() : dSize;
        const sf = f & 0x400 ? q.u32() : (i === 0 && firstFlags !== null ? firstFlags : dFlags);
        const cto = f & 0x800 ? q.i32() : 0; // signed in v1; v0 values never reach 2^31
        if (t) t.samples.push({ off: pos, size, dur, cto, sync: !(sf & 0x10000), sdi });
        pos += size;
      }
    }
    prevEnd = pos;
  }
}

async function parseClip(blob) {
  const tops = await topBoxes(blob);
  const moovBox = tops.find((b) => b.type === 'moov');
  if (!moovBox) throw new Error('This clip has no moov box (not an MP4?)');
  const u8 = await readBytes(blob, moovBox.s, moovBox.e);
  const root = kids(u8, 0, u8.length)[0];
  const tracks = kids(u8, root.d, root.e).filter((b) => b.type === 'trak').map((b) => parseTrak(u8, b));
  const byId = Object.fromEntries(tracks.map((t) => [t.id, t]));

  const trex = {};
  const mvex = child(u8, root, 'mvex');
  if (mvex) {
    for (const b of kids(u8, mvex.d, mvex.e)) {
      if (b.type !== 'trex') continue;
      const r = new Reader(u8, b.d + 4);
      const id = r.u32();
      trex[id] = { sdi: r.u32(), dur: r.u32(), size: r.u32(), flags: r.u32() };
    }
  }
  for (const b of tops) {
    if (b.type !== 'moof') continue;
    readMoof(await readBytes(blob, b.s, b.e), b.s, byId, trex);
  }
  // Media bytes we will carry over: every mdat payload, in file order.
  const ranges = tops.filter((b) => b.type === 'mdat').map((b) => ({ s: b.d, e: b.e }));
  return { blob, tracks, ranges };
}

// ---------- writing ----------

class Writer {
  constructor() { this.buf = new Uint8Array(1 << 16); this.n = 0; }
  ensure(k) {
    if (this.n + k <= this.buf.length) return;
    const nb = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
    nb.set(this.buf.subarray(0, this.n));
    this.buf = nb;
  }
  u8(v) { this.ensure(1); this.buf[this.n++] = v & 255; }
  u16(v) { this.u8(v >>> 8); this.u8(v); }
  u32(v) { v >>>= 0; this.ensure(4); this.buf[this.n++] = v >>> 24; this.buf[this.n++] = (v >>> 16) & 255; this.buf[this.n++] = (v >>> 8) & 255; this.buf[this.n++] = v & 255; }
  u64(v) { this.u32(Math.floor(v / 2 ** 32)); this.u32(v % 2 ** 32); }
  i64(v) { if (v >= 0) this.u64(v); else { const hi = Math.floor(v / 2 ** 32); this.u32(hi >>> 0); this.u32((v - hi * 2 ** 32) >>> 0); } }
  bytes(a) { this.ensure(a.length); this.buf.set(a, this.n); this.n += a.length; }
  str(s) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i)); }
  zeros(k) { for (let i = 0; i < k; i++) this.u8(0); }
  box(type, fn) {
    const s = this.n;
    this.u32(0); this.str(type); fn();
    const size = this.n - s;
    this.buf[s] = size >>> 24; this.buf[s + 1] = (size >>> 16) & 255; this.buf[s + 2] = (size >>> 8) & 255; this.buf[s + 3] = size & 255;
  }
  full(type, version, flags, fn) { this.box(type, () => { this.u32(((version << 24) | flags) >>> 0); fn(); }); }
  out() { return this.buf.slice(0, this.n); }
}

const IDENTITY = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

function rle(values) {
  const out = [];
  for (const v of values) {
    const last = out[out.length - 1];
    if (last && last[1] === v) last[0]++; else out.push([1, v]);
  }
  return out;
}

function writeTrak(w, t, id, now) {
  const movieDur = Math.round((t.duration * MOVIE_TIMESCALE) / t.timescale);
  w.box('trak', () => {
    w.full('tkhd', 1, 3, () => {
      w.u64(now); w.u64(now); w.u32(id); w.u32(0); w.u64(movieDur);
      w.zeros(8); w.u16(t.layer & 0xffff); w.u16(t.altGroup & 0xffff); w.u16(t.volume & 0xffff); w.u16(0);
      w.bytes(t.matrix); w.u32(t.width); w.u32(t.height);
    });
    if (t.mediaStart > 0) {
      w.box('edts', () => w.full('elst', 1, 0, () => {
        w.u32(1);
        w.u64(Math.max(0, movieDur - Math.round((t.mediaStart * MOVIE_TIMESCALE) / t.timescale)));
        w.i64(t.mediaStart); w.u16(1); w.u16(0);
      }));
    }
    w.box('mdia', () => {
      w.full('mdhd', 1, 0, () => { w.u64(now); w.u64(now); w.u32(t.timescale); w.u64(t.duration); w.u16(t.language); w.u16(0); });
      w.bytes(t.hdlrBox);
      w.box('minf', () => {
        if (t.mhdBox) w.bytes(t.mhdBox);
        else if (t.handler === 'soun') w.full('smhd', 0, 0, () => w.u32(0));
        else w.full('vmhd', 0, 1, () => w.zeros(8));
        if (t.dinfBox) w.bytes(t.dinfBox);
        else w.box('dinf', () => w.full('dref', 0, 0, () => { w.u32(1); w.full('url ', 0, 1, () => {}); }));
        writeStbl(w, t);
      });
    });
  });
}

function writeStbl(w, t) {
  const s = t.out;
  w.box('stbl', () => {
    w.full('stsd', 0, 0, () => { w.u32(t.entries.length); for (const e of t.entries) w.bytes(e); });

    const stts = rle(s.map((x) => x.dur));
    w.full('stts', 0, 0, () => { w.u32(stts.length); for (const [c, d] of stts) { w.u32(c); w.u32(d); } });

    if (s.some((x) => x.cto !== 0)) {
      const neg = s.some((x) => x.cto < 0);
      const ctts = rle(s.map((x) => x.cto));
      w.full('ctts', neg ? 1 : 0, 0, () => { w.u32(ctts.length); for (const [c, o] of ctts) { w.u32(c); w.u32(o); } });
    }

    if (s.some((x) => !x.sync)) {
      const idx = [];
      s.forEach((x, i) => { if (x.sync) idx.push(i + 1); });
      w.full('stss', 0, 0, () => { w.u32(idx.length); for (const i of idx) w.u32(i); });
    }

    // Chunks: runs of samples that sit back to back in the output file.
    const chunks = [];
    for (const x of s) {
      const c = chunks[chunks.length - 1];
      if (c && c.end === x.newOff && c.sdi === x.sdi) { c.n++; c.end += x.size; }
      else chunks.push({ off: x.newOff, end: x.newOff + x.size, n: 1, sdi: x.sdi });
    }
    const stsc = [];
    chunks.forEach((c, i) => {
      const last = stsc[stsc.length - 1];
      if (!last || last[1] !== c.n || last[2] !== c.sdi) stsc.push([i + 1, c.n, c.sdi]);
    });
    w.full('stsc', 0, 0, () => { w.u32(stsc.length); for (const [a, b, c] of stsc) { w.u32(a); w.u32(b); w.u32(c); } });

    const same = s.length > 0 && s.every((x) => x.size === s[0].size);
    w.full('stsz', 0, 0, () => {
      w.u32(same ? s[0].size : 0); w.u32(s.length);
      if (!same) for (const x of s) w.u32(x.size);
    });
    w.full('co64', 0, 0, () => { w.u32(chunks.length); for (const c of chunks) w.u64(c.off); });
  });
}

/**
 * Join MP4 clips (Blobs) in order into one MP4 Blob, without re-encoding.
 * @param {Blob[]} blobs
 * @returns {Promise<Blob>}
 */
export async function joinMp4(blobs) {
  if (!blobs.length) throw new Error('No clips to join');
  const clips = [];
  for (const b of blobs) clips.push(await parseClip(b));

  // Output tracks follow the first clip's video and audio tracks.
  const outTracks = clips[0].tracks
    .filter((t) => (t.handler === 'vide' || t.handler === 'soun') && t.samples.length)
    .map((t) => ({ ...t, entries: [], entryKeys: new Map(), out: [], duration: 0, mediaStart: 0, lead: t }));
  if (!outTracks.length) throw new Error('The first clip has no video or audio');

  // Lay the clips' media bytes out one after another.
  let cursor = 0;
  const parts = [];
  for (const c of clips) {
    c.map = c.ranges.map((r) => { const m = { s: r.s, e: r.e, dst: cursor }; cursor += r.e - r.s; parts.push(c.blob.slice(r.s, r.e)); return m; });
  }
  const dataSize = cursor;

  for (let ci = 0; ci < clips.length; ci++) {
    const c = clips[ci];
    const used = new Set();
    const per = outTracks.map((o) => {
      const src = c.tracks.find((t) => t.handler === o.handler && !used.has(t));
      if (src) used.add(src);
      return src;
    });

    // Every track ends at the same moment at the end of each clip, so sound stays in sync.
    const clipSec = Math.max(0, ...per.map((t) => (t ? t.samples.reduce((a, x) => a + x.dur, 0) / t.timescale : 0)));

    outTracks.forEach((o, k) => {
      const src = per[k];
      const start = o.out.length;
      if (src && src.samples.length) {
        const entryIndex = src.entries.map((e) => {
          const key = hex(e);
          if (!o.entryKeys.has(key)) { o.entries.push(e); o.entryKeys.set(key, o.entries.length); }
          return o.entryKeys.get(key);
        });
        const scale = o.timescale / src.timescale;
        let carry = 0;
        for (const x of src.samples) {
          const m = c.map.find((r) => x.off >= r.s && x.off + x.size <= r.e);
          if (!m) throw new Error('A clip points at media outside its data');
          const exact = x.dur * scale + carry;
          const dur = Math.max(0, Math.round(exact));
          carry = exact - dur;
          o.out.push({
            size: x.size, dur, cto: Math.round(x.cto * scale), sync: x.sync,
            sdi: entryIndex[(x.sdi || 1) - 1] || 1, newOff: m.dst + (x.off - m.s),
          });
        }
      }
      const got = o.out.slice(start).reduce((a, x) => a + x.dur, 0);
      const want = Math.round(clipSec * o.timescale);
      if (o.out.length && want > got) o.out[o.out.length - 1].dur += want - got;
      o.duration += Math.max(want, got);

      if (ci === 0 && o.out.length) {
        // Delay from B-frame reordering: keep the first frame at time zero.
        let dts = 0, minPts = Infinity;
        for (let i = 0; i < Math.min(o.out.length, 64); i++) { minPts = Math.min(minPts, dts + o.out[i].cto); dts += o.out[i].dur; }
        o.mediaStart = Math.max(0, minPts);
      }
    });
  }

  const now = Math.floor(Date.now() / 1000) + 2082844800;
  const ftyp = new Writer();
  ftyp.box('ftyp', () => { ftyp.str('isom'); ftyp.u32(0x200); for (const b of ['isom', 'iso2', 'avc1', 'mp41']) ftyp.str(b); });
  const ftypBytes = ftyp.out();

  const buildMoov = (base) => {
    const w = new Writer();
    for (const o of outTracks) for (const x of o.out) x.newOff = x.rel + base;
    const movieDur = Math.max(...outTracks.map((o) => Math.round((o.duration * MOVIE_TIMESCALE) / o.timescale)));
    w.box('moov', () => {
      w.full('mvhd', 1, 0, () => {
        w.u64(now); w.u64(now); w.u32(MOVIE_TIMESCALE); w.u64(movieDur);
        w.u32(0x00010000); w.u16(0x0100); w.zeros(10);
        for (const v of IDENTITY) w.u32(v);
        w.zeros(24); w.u32(outTracks.length + 1);
      });
      outTracks.forEach((o, i) => writeTrak(w, o, i + 1, now));
    });
    return w.out();
  };
  for (const o of outTracks) for (const x of o.out) x.rel = x.newOff;
  const size = buildMoov(0).length; // co64 offsets are fixed width, so the size does not change
  const moov = buildMoov(ftypBytes.length + size + 16);

  const mdatHead = new Writer();
  mdatHead.u32(1); mdatHead.str('mdat'); mdatHead.u64(16 + dataSize);

  return new Blob([ftypBytes, moov, mdatHead.out(), ...parts], { type: 'video/mp4' });
}

/** Clip duration in seconds, read from the file. */
export async function mp4Duration(blob) {
  const c = await parseClip(blob);
  return Math.max(0, ...c.tracks.map((t) => t.samples.reduce((a, x) => a + x.dur, 0) / t.timescale));
}
