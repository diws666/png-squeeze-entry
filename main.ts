// png-squeeze-01 entry: program/v1, Node 22, stdlib only.
// Reads /input/<id>/image.png (stored RGBA PNG, unfiltered rows), re-encodes each
// screenshot to the smallest valid contest PNG the checker decodes, writes
// /output/<id>/image.png. Deterministic: no clock, no randomness, no env reads.
// Colour-type reduction (palette / grey / RGB / RGBA) + per-image filter search
// across None/Sub/Up/Average/Paeth plus the minsum and pairs heuristics, each
// compressed with zlib level 9; the smallest total (chunks + IDAT) wins.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync, constants } from 'node:zlib';
import { join } from 'node:path';

const { Z_DEFAULT_STRATEGY } = constants;

const SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = data.length;
  const out = new Uint8Array(12 + len);
  const v = new DataView(out.buffer);
  v.setUint32(0, len);
  out.set(Uint8Array.from(type, (ch) => ch.charCodeAt(0)), 4);
  out.set(data, 8);
  v.setUint32(8 + len, crc32(out, 4, 8 + len));
  return out;
}

function ihdr(width, height, ct) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = ct;
  return d;
}

function writePng(width, height, colourType, plte, trns, idat) {
  const chunks = [['IHDR', ihdr(width, height, colourType)]];
  if (plte !== null) chunks.push(['PLTE', plte]);
  if (trns !== null) chunks.push(['tRNS', trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  let size = SIG.length;
  for (const [, d] of chunks) size += 12 + d.length;
  const out = new Uint8Array(size);
  out.set(SIG, 0);
  let at = SIG.length;
  for (const [type, d] of chunks) {
    const c = chunk(type, d);
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const p = (row[i - 1] << 8) | row[i];
    if (seen[p] !== stamp) {
      seen[p] = stamp;
      n++;
    }
  }
  return n;
}

// Decode the stored RGBA input PNG (colour type 6, unfiltered rows, stored zlib blocks).
function decodeStoredRgba(bytes) {
  if (bytes.length < SIG.length || SIG.some((b, i) => bytes[i] !== b)) throw new Error('bad signature');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = SIG.length;
  let width = 0, height = 0, colourType = 0;
  const idat = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    if (at + 12 > bytes.length) throw new Error('chunk cut short');
    const len = v.getUint32(at);
    if (at + 12 + len > bytes.length) throw new Error('chunk length overrun');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = dv.getUint32(0); height = dv.getUint32(4);
      colourType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
    }
  }
  if (!ended) throw new Error('no IEND');
  const idatBuf = Buffer.concat(idat.map((b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength)));
  const raw = inflateSync(idatBuf);
  if (colourType !== 6) throw new Error('input is not colour type 6');
  const stride = width * 4;
  const expected = height * (stride + 1);
  if (raw.length !== expected) throw new Error('inflated size mismatch');
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    rgba.set(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride), y * stride);
  }
  return { rgba, width, height };
}

function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = ((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0;
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many ? null : [...counts.keys()].map((c) => ({
    r: (c >>> 24) & 0xff, g: (c >>> 16) & 0xff, b: (c >>> 8) & 0xff, a: c & 0xff,
    word: c, count: counts.get(c),
  }));
  return { opaque, grey, colours };
}

// Colour key must be unsigned (>>> 0) so Uint32Array storage matches the Map keys.
function colourWord(r, g, b, a) { return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0; }

// Build a palette form from `colours` using the given entry order.
function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = colours.slice().sort((x, y) => {
    const ta = x.a === 255 ? 1 : 0;
    const tb = y.a === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r; plte[i * 3 + 1] = c.g; plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : new Uint8Array(entries.slice(0, transparent).map((c) => c.a));
  const n = rgba.length >>> 2;
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const indices = new Uint8Array(n);
  const u32 = new Uint32Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) u32[i] = colourWord(rgba[d], rgba[d + 1], rgba[d + 2], rgba[d + 3]);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

// Candidate output forms (colour type + samples + chunks). Empty = use RGBA fallback.
function chooseForms(rgba, width, height) {
  const { opaque, grey, colours } = analyse(rgba);
  const n = rgba.length >>> 2;
  const forms = [];
  if (grey) {
    const ct = opaque ? 0 : 4;
    forms.push({ colourType: ct, bpp: ct === 0 ? 1 : 2, samples: samplesOf(rgba, ct), plte: null, trns: null });
    return forms; // grey images never benefit from a palette
  }
  if (colours !== null) {
    // Flat: at most 256 distinct colours -> palette type 3, tried by count and by luminance.
    for (const order of ['count', 'luminance']) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns });
    }
    return forms;
  }
  if (opaque) {
    forms.push({ colourType: 2, bpp: 3, samples: samplesOf(rgba, 2), plte: null, trns: null });
    return forms;
  }
  // Alpha theme, colour varies: RGBA type 6.
  forms.push({ colourType: 6, bpp: 4, samples: rgba, plte: null, trns: null });
  return forms;
}

function filterImage(samples, width, height, bpp, choice, seen, stamp) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const fixed = typeof choice === 'number';
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (fixed) {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      const cost = choice === 'minsum' ? signedSum(trial[t]) : pairsOf(trial[t], seen, stamp);
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw[at] = type;
    raw.set(trial[type], at + 1);
  }
  return raw;
}

const ZLIB_OPTS = { level: 9, memLevel: 9, strategy: Z_DEFAULT_STRATEGY };
const FILTER_CHOICES = Object.freeze([0, 1, 2, 3, 4, 'minsum', 'pairs']);

// Compress `form` trying every filter choice; return the smallest IDAT stream.
function deflateBest(form, width, height) {
  const { bpp, samples } = form;
  const stride = width * bpp;
  const seen = new Uint32Array(65536);
  let stamp = 0;
  let bestIdat = null;
  let bestLen = Infinity;
  for (const choice of FILTER_CHOICES) {
    stamp++;
    const raw = filterImage(samples, width, height, bpp, choice, seen, stamp);
    const compressed = deflateSync(raw, ZLIB_OPTS);
    const len = compressed.byteLength;
    if (len < bestLen) {
      bestLen = len;
      bestIdat = new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.length);
    }
  }
  return bestIdat;
}

function encodePng(form, width, height) {
  const idat = deflateBest(form, width, height);
  return writePng(width, height, form.colourType, form.plte, form.trns, idat);
}

function run() {
  const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const ids = readdirSync(I).sort();
  for (const id of ids) {
    const bytes = readFileSync(join(I, id, 'image.png'));
    const { rgba, width, height } = decodeStoredRgba(bytes);
    const forms = chooseForms(rgba, width, height);
    let best = null;
    for (const form of forms) {
      const png = encodePng(form, width, height);
      if (best === null || png.byteLength < best.byteLength) {
        best = png;
      }
    }
    mkdirSync(join(O, id), { recursive: true });
    writeFileSync(join(O, id, 'image.png'), best);
  }
}

run();
