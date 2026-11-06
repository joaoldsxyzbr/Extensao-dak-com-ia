// Treinador da rede de regioes (Darl Dark).
// Executar: node tools/train-region-model.js
// Gera ../weights-region.js.
//
// A rede decide, por bloco escuro numa pagina invertida, se o bloco deve
// "manter original" (neutralizar a inversao, classe .dd-region) ou seguir a
// inversao da pagina junto. Features:
//   [lum, sat, textLum, contrast, areaFrac, isFixed, hasBgImg, childMediaFrac]
"use strict";

const fs = require("fs");
const path = require("path");

const IN = 8, H1 = 12, OUT = 1;

// arquétipos: keep=1 -> manter original (bloco escuro preservado)
const ARCH = [
  { // header/menu escuro fixo em pagina clara
    name: "DARK_HEADER", w: 0.22,
    f: { lum: 0.10, sat: 0.3, textLum: 0.85, contrast: 0.8, areaFrac: 0.12, isFixed: 0.8, hasBgImg: 0, childMediaFrac: 0.05 },
    vary: { lum: 0.05, sat: 0.15, textLum: 0.06, contrast: 0.06, areaFrac: 0.06, isFixed: 0.25 },
    keep: 1,
  },
  { // footer escuro
    name: "DARK_FOOTER", w: 0.15,
    f: { lum: 0.08, sat: 0.2, textLum: 0.8, contrast: 0.75, areaFrac: 0.08, isFixed: 0, hasBgImg: 0, childMediaFrac: 0.03 },
    vary: { lum: 0.04, textLum: 0.05, areaFrac: 0.04, contrast: 0.05 },
    keep: 1,
  },
  { // hero/banner escuro com imagem de fundo (texto branco sobre foto)
    name: "DARK_HERO", w: 0.18,
    f: { lum: 0.25, sat: 0.35, textLum: 0.9, contrast: 0.7, areaFrac: 0.45, isFixed: 0, hasBgImg: 1, childMediaFrac: 0.05 },
    vary: { lum: 0.12, areaFrac: 0.2, textLum: 0.06, contrast: 0.08, sat: 0.15 },
    keep: 1,
  },
  { // card de codigo / widget escuro em pagina clara (docs)
    name: "DARK_CARD", w: 0.2,
    f: { lum: 0.12, sat: 0.25, textLum: 0.85, contrast: 0.8, areaFrac: 0.05, isFixed: 0, hasBgImg: 0, childMediaFrac: 0.02 },
    vary: { lum: 0.05, areaFrac: 0.03, sat: 0.12, textLum: 0.06, contrast: 0.06 },
    keep: 1,
  },
  { // painel cinza intermediario (~#666): segue a inversao da pagina por consistencia
    name: "MID_PANEL", w: 0.1,
    f: { lum: 0.4, sat: 0.15, textLum: 0.5, contrast: 0.5, areaFrac: 0.2, isFixed: 0, hasBgImg: 0, childMediaFrac: 0.05 },
    vary: { lum: 0.05, sat: 0.1, textLum: 0.1, contrast: 0.1, areaFrac: 0.1 },
    keep: 0,
  },
  { // bloco claro de conteudo (segue a inversao da pagina)
    name: "LIGHT_CONTENT", w: 0.2,
    f: { lum: 0.85, sat: 0.1, textLum: 0.12, contrast: 0.85, areaFrac: 0.5, isFixed: 0, hasBgImg: 0, childMediaFrac: 0.05 },
    vary: { lum: 0.08, areaFrac: 0.25, textLum: 0.05, contrast: 0.05, sat: 0.08 },
    keep: 0,
  },
];

let seed = 0x5f3a9c1;
function rnd() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967295); }
const jit = (s) => (rnd() * 2 - 1) * s;
const c01 = (x) => Math.min(1, Math.max(0, x));

function sampleOne() {
  let r = rnd() * ARCH.reduce((s, a) => s + a.w, 0);
  let a = ARCH[0];
  for (const arch of ARCH) { r -= arch.w; if (r <= 0) { a = arch; break; } }
  const x = [a.f.lum, a.f.sat, a.f.textLum, a.f.contrast, a.f.areaFrac, rnd() < a.f.isFixed ? 1 : 0, a.f.hasBgImg, a.f.childMediaFrac];
  for (const [k, amp] of Object.entries(a.vary)) x[ORDER2.indexOf(k)] = c01(x[ORDER2.indexOf(k)] + jit(amp));
  x.forEach((v, i) => { x[i] = c01(v + jit(0.015)); });
  return { x, y: [a.keep] };
}
const ORDER2 = ["lum", "sat", "textLum", "contrast", "areaFrac", "isFixed", "hasBgImg", "childMediaFrac"];

const dims = [IN, H1, OUT];
const W = [], B = [];
for (let l = 0; l < dims.length - 1; l++) {
  W.push(Array.from({ length: dims[l + 1] }, () => Array.from({ length: dims[l] }, () => (rnd() * 2 - 1) * 0.3)));
  B.push(new Array(dims[l + 1]).fill(0));
}
const acts = [new Array(IN).fill(0), new Array(H1).fill(0), new Array(OUT).fill(0)];
const delta = [new Array(H1).fill(0), new Array(OUT).fill(0)];

function forward(x) {
  for (let i = 0; i < IN; i++) acts[0][i] = x[i];
  for (let i = 0; i < H1; i++) { let z = B[0][i]; const row = W[0][i]; for (let k = 0; k < IN; k++) z += row[k] * x[k]; acts[1][i] = Math.tanh(z); }
  for (let i = 0; i < OUT; i++) { let z = B[1][i]; const row = W[1][i]; for (let k = 0; k < H1; k++) z += row[k] * acts[1][k]; acts[2][i] = 1 / (1 + Math.exp(-z)); }
}
function decide(x) { forward(x); return acts[2][0]; }

const N = 500, EPOCHS = 200;
for (let e = 0; e < EPOCHS; e++) {
  const lr = e < 140 ? 0.12 : 0.05;
  for (let i = 0; i < N; i++) {
    const { x, y } = sampleOne();
    forward(x);
    const p = acts[2][0];
    delta[1][0] = (p - y[0]) * p * (1 - p);
    const w1 = W[1][0];
    for (let h = 0; h < H1; h++) {
      let d = w1[h] * delta[1][0];
      delta[0][h] = d * (1 - acts[1][h] ** 2);
    }
    for (let h = 0; h < H1; h++) w1[h] -= lr * delta[1][0] * acts[1][h];
    B[1][0] -= lr * delta[1][0];
    for (let h = 0; h < H1; h++) {
      const row = W[0][h];
      for (let k = 0; k < IN; k++) row[k] -= lr * delta[0][h] * acts[0][k];
      B[0][h] -= lr * delta[0][h];
    }
  }
}

let fails = 0;
for (const a of ARCH) {
  const x = [a.f.lum, a.f.sat, a.f.textLum, a.f.contrast, a.f.areaFrac, a.f.isFixed >= 0.5 ? 1 : 0, a.f.hasBgImg, a.f.childMediaFrac];
  const p = decide(x);
  const got = p > 0.5 ? 1 : 0;
  if (got !== a.keep) fails++;
  console.log(`${got === a.keep ? "OK " : "ERR"} ${a.name.padEnd(13)} keep=${got} (p=${p.toFixed(3)})`);
}
let acc = 0, M = 4000;
for (let i = 0; i < M; i++) {
  const { x, y } = sampleOne();
  if ((decide(x) > 0.5 ? 1 : 0) === y[0]) acc++;
}
console.log(`acerto geral: ${(100 * acc / M).toFixed(2)}%`);
if (fails > 0 || acc / M < 0.99) { console.error("treino insatisfatorio, pesos NAO salvos"); process.exit(1); }

const r5 = (v) => Math.round(v * 1e5) / 1e5;
const weights = { dims, W: W.map((m) => m.map((row) => row.map(r5))), b: B.map((v) => v.map(r5)) };
const header = `// Pesos da rede de regioes ([8, 12, 1]).
// ARQUIVO GERADO por tools/train-region-model.js - nao editar a mao.
// Decide por bloco escuro em pagina invertida: manter original (dd-region) ou seguir.
// Entradas: [lum, sat, textLum, contrast, areaFrac, isFixed, hasBgImg, childMediaFrac]
"use strict";

globalThis.DARL_REGION_WEIGHTS = `;
const out = header + JSON.stringify(weights) + ";\n";
const dest = path.join(__dirname, "..", "weights-region.js");
fs.writeFileSync(dest, out);
console.log(`pesos salvos em ${dest} (${out.length} bytes)`);
