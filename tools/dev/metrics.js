"use strict";

// Metricas perceptuais de screenshots (Extensão Dark com IA - tools/dev).
// Node puro, sem dependencias: decodifica PNG (zlib nativo) e calcula
// luminancia media, fracao escura, desvio de luminancia (proxy de contraste
// texto/fundo) e deltaE76 medio entre o antes e o depois. Usado pelo crawler
// (crawl.js) e pelo fluxo de auto-labeling do dataset real.
//
// Uso: node metrics.js antes.png depois.png

const fs = require("fs");
const zlib = require("zlib");

// ------------------------------------------------------------- decodifica PNG

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("nao e PNG");
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  let palette = null, trns = null;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`PNG com bit depth ${bitDepth} (esperado 8)`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`PNG com color type ${colorType} nao suportado`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    // unfilter (RFC 2083): os 5 filtros basais
    const cur = Buffer.from(line);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = cur[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (v + pr) & 0xff;
      }
      cur[x] = v;
    }
    // expande para RGBA
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 6) { out[o] = cur[x * 4]; out[o + 1] = cur[x * 4 + 1]; out[o + 2] = cur[x * 4 + 2]; out[o + 3] = cur[x * 4 + 3]; }
      else if (colorType === 2) { out[o] = cur[x * 3]; out[o + 1] = cur[x * 3 + 1]; out[o + 2] = cur[x * 3 + 2]; out[o + 3] = 255; }
      else if (colorType === 0) { const g = cur[x]; out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = 255; }
      else if (colorType === 4) { const g = cur[x * 2]; out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = cur[x * 2 + 1]; }
      else if (colorType === 3) {
        const idx = cur[x];
        out[o] = palette[idx * 3]; out[o + 1] = palette[idx * 3 + 1]; out[o + 2] = palette[idx * 3 + 2];
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
    prev = cur;
  }
  return { width, height, data: out };
}

// ------------------------------------------------------------------ metricas

function downsampleRGBA(img, targetW) {
  const { width, height, data } = img;
  const scale = Math.max(1, Math.floor(width / targetW));
  const w = Math.floor(width / scale), h = Math.floor(height / scale);
  const out = { width: w, height: h, data: new Float64Array(w * h * 4) };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const o = ((y * scale + dy) * width + (x * scale + dx)) * 4;
          r += data[o]; g += data[o + 1]; b += data[o + 2]; a += data[o + 3]; n++;
        }
      }
      const o2 = (y * w + x) * 4;
      out.data[o2] = r / n; out.data[o2 + 1] = g / n; out.data[o2 + 2] = b / n; out.data[o2 + 3] = a / n;
    }
  }
  return out;
}

const lumOf = (px, o) => (0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]) / 255;

function lumStats(img) {
  const { width, height, data } = img;
  let sum = 0, sumSq = 0, dark = 0, light = 0, n = 0;
  for (let o = 0; o < data.length; o += 4) {
    if (data[o + 3] < 128) continue; // pixels transparentes fora da conta
    const l = lumOf(data, o);
    sum += l; sumSq += l * l; n++;
    if (l < 0.25) dark++;
    else if (l > 0.75) light++;
  }
  const mean = sum / n;
  return {
    meanLum: mean,
    lumStd: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
    darkFrac: dark / n,
    lightFrac: light / n,
    n,
  };
}

// recorte horizontal (fraçao 0..1 do inicio ao fim) para checar regioes
function cropH(img, x0, x1) {
  const { width, height, data } = img;
  const w0 = Math.floor(width * x0), w1 = Math.ceil(width * x1);
  const w = w1 - w0;
  const out = new Float64Array(w * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const s = (y * width + (w0 + x)) * 4;
      out[o] = data[s]; out[o + 1] = data[s + 1]; out[o + 2] = data[s + 2]; out[o + 3] = data[s + 3];
    }
  }
  return { width: w, height, data: out };
}

// deltaE76 medio entre duas imagens de mesmas dimensoes (Lab euclidiano)
function rgbToLab(r, g, b) {
  const f = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const R = f(r), G = f(g), B = f(b);
  let x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  let y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  let z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const g2 = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = g2(x); y = g2(y); z = g2(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function deltaE76(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new Error("dimensoes diferentes");
  let sum = 0, n = 0;
  const step = 4 * 8; // amostra 1 a cada 8 pixels
  for (let o = 0; o < a.data.length; o += step) {
    if (a.data[o + 3] < 128) continue;
    const la = rgbToLab(a.data[o], a.data[o + 1], a.data[o + 2]);
    const lb = rgbToLab(b.data[o], b.data[o + 1], b.data[o + 2]);
    sum += Math.sqrt((la[0] - lb[0]) ** 2 + (la[1] - lb[1]) ** 2 + (la[2] - lb[2]) ** 2);
    n++;
  }
  return n ? sum / n : 0;
}

// ---------------------------------------------------------------------- CLI

function analyze(file) {
  const img = decodePNG(fs.readFileSync(file));
  const small = downsampleRGBA(img, 320);
  return { stats: lumStats(small), img: small, width: img.width, height: img.height };
}

module.exports = { decodePNG, downsampleRGBA, lumStats, cropH, deltaE76, analyze };

if (require.main === module) {
  const [a, b] = process.argv.slice(2);
  const A = analyze(a);
  console.log(`${a}: ${A.width}x${A.height} meanLum=${A.stats.meanLum.toFixed(3)} darkFrac=${A.stats.darkFrac.toFixed(3)} lumStd=${A.stats.lumStd.toFixed(3)}`);
  if (b) {
    const B = analyze(b);
    const de = deltaE76(A.img, B.img);
    console.log(`${b}: meanLum=${B.stats.meanLum.toFixed(3)} darkFrac=${B.stats.darkFrac.toFixed(3)} lumStd=${B.stats.lumStd.toFixed(3)}`);
    console.log(`deltaE76 medio antes->depois: ${de.toFixed(1)}`);
  }
}
