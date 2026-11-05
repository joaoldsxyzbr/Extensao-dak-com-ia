// Treinador do modelo v2 da rede de paginas (Darl Dark).
// Executar: node tools/train-page-model.js
// Gera ../weights-page.js com a matriz de pesos treinados.
"use strict";

const fs = require("fs");
const path = require("path");

const IN = 32, H1 = 24, H2 = 16, OUT = 6;

// 32 features, por nome (ordem canonica):
const ORDER = [
  "htmlBg", "meanBg",
  "h0", "h1", "h2", "h3", "h4", "h5", "h6", "h7",
  "fracWithBg", "fracDark", "fracLight",
  "textLum", "lowContrast", "contrast",
  "satMean", "satHigh", "colorful",
  "imgFrac", "bgImgFrac", "mono", "fontMean", "titleFrac", "smallUi", "fixedFrac",
  "articleN", "navN", "tableN", "formN", "mediaN", "metaDark",
];
const IDX = Object.fromEntries(ORDER.map((k, i) => [k, i]));

// saidas: [inverter, brilho, contraste, sepia, dim, tint]
// mapeamento variaveis:
//   invert TRUE : brilho = 0.6 + 0.8*b, contraste = 0.6 + 0.8*c, sepia = 0.5*s, tint = 0.25*t
//   invert FALSE: brilho = 0.7 + 0.3*dim, contraste = 0.9 + 0.25*c, sepia = 0.5*s, tint = 0.25*t
const ARCHETYPES = [
  {
    // Site claro comum com acoes (feed, blog, loja)
    name: "LIGHT_WEB", weight: 0.35,
    f: { htmlBg: 0.95, meanBg: 0.9, h6: 0.05, h7: 0.75, fracWithBg: 0.35, fracDark: 0.06, fracLight: 0.78,
      textLum: 0.13, lowContrast: 0.05, contrast: 0.85, satMean: 0.12, satHigh: 0.08, colorful: 0.12,
      imgFrac: 0.05, bgImgFrac: 0.08, mono: 0.08, fontMean: 0.55, titleFrac: 0.05, smallUi: 0.2, fixedFrac: 0.08,
      articleN: 0.4, navN: 0.6, tableN: 0.15, formN: 0.3, mediaN: 0.2, metaDark: 0.02 },
    vary: { htmlBg: 0.04, meanBg: 0.05, h7: 0.15, fracWithBg: 0.1, fracDark: 0.1, fracLight: 0.06,
      textLum: 0.05, contrast: 0.05, satMean: 0.05, satHigh: 0.06, colorful: 0.07, mono: 0.1,
      fontMean: 0.1, titleFrac: 0.04, smallUi: 0.1 },
    y: [1, 0.44, 0.44, 0.08, 0.5, 0.02],
  },
  {
    // Pagina branca dura (docs tecnicos, login vazio, grade)
    name: "HARSH_WHITE", weight: 0.1,
    f: { htmlBg: 1.0, meanBg: 0.97, h7: 0.85, fracWithBg: 0.3, fracDark: 0.01, fracLight: 0.93,
      textLum: 0.05, lowContrast: 0.02, contrast: 0.92, satMean: 0.05, satHigh: 0.02, colorful: 0.05,
      imgFrac: 0.03, bgImgFrac: 0.25, mono: 0.5, fontMean: 0.5, titleFrac: 0.02, smallUi: 0.25, fixedFrac: 0.02,
      articleN: 0.3, navN: 0.6, tableN: 0.25, formN: 0.2, mediaN: 0.02, metaDark: 0.02 },
    vary: { h7: 0.1, fracWithBg: 0.08, textLum: 0.03, contrast: 0.04, mono: 0.15, smallUi: 0.08, formN: 0.15 },
    y: [1, 0.35, 0.4, 0.12, 0.5, 0.2],
  },
  {
    // Noticias/leitores com fundo creme quente e texto marrom
    name: "CREAM", weight: 0.1,
    f: { htmlBg: 0.9, meanBg: 0.88, h6: 0.05, h7: 0.6, fracWithBg: 0.4, fracDark: 0.05, fracLight: 0.7,
      textLum: 0.25, lowContrast: 0.12, contrast: 0.75, satMean: 0.35, satHigh: 0.3, colorful: 0.5,
      imgFrac: 0.04, bgImgFrac: 0.06, mono: 0.06, fontMean: 0.55, titleFrac: 0.12, smallUi: 0.15, fixedFrac: 0.05,
      articleN: 0.7, navN: 0.5, tableN: 0.1, formN: 0.15, mediaN: 0.1, metaDark: 0.05 },
    vary: { htmlBg: 0.04, h7: 0.12, fracLight: 0.08, textLum: 0.08, lowContrast: 0.05,
      satMean: 0.08, satHigh: 0.1, colorful: 0.1, titleFrac: 0.05 },
    y: [1, 0.44, 0.4, 0.04, 0.5, 0.3],
  },
  {
    // Site ja escuro (tema dark do site, foruns escuros)
    name: "DARK", weight: 0.22,
    f: { htmlBg: 0.07, meanBg: 0.11, h0: 0.55, h1: 0.25, fracWithBg: 0.5, fracDark: 0.82, fracLight: 0.02,
      textLum: 0.8, lowContrast: 0.07, contrast: 0.78, satMean: 0.28, satHigh: 0.15, colorful: 0.2,
      imgFrac: 0.05, bgImgFrac: 0.05, mono: 0.05, fontMean: 0.55, titleFrac: 0.05, smallUi: 0.3, fixedFrac: 0.1,
      articleN: 0.35, navN: 0.6, tableN: 0.2, formN: 0.35, mediaN: 0.5, metaDark: 0.8 },
    vary: { htmlBg: 0.045, meanBg: 0.05, h0: 0.15, h1: 0.1, fracDark: 0.1, textLum: 0.07,
      contrast: 0.05, satMean: 0.06, satHigh: 0.08, smallUi: 0.1, metaDark: 0.25 },
    y: [0, 0.5, 0.2, 0.02, 0.45, 0.04], // dim real calculado por amostra com base no htmlBg
  },
  {
    // Dashboard/painel escuro saturado (azuis, violetas, SaaS admin)
    name: "BLUE_DASH", weight: 0.1,
    f: { htmlBg: 0.1, meanBg: 0.15, h0: 0.5, h1: 0.3, fracWithBg: 0.6, fracDark: 0.75, fracLight: 0.03,
      textLum: 0.85, lowContrast: 0.05, contrast: 0.8, satMean: 0.6, satHigh: 0.7, colorful: 0.7,
      imgFrac: 0.04, bgImgFrac: 0.08, mono: 0.08, fontMean: 0.5, titleFrac: 0.03, smallUi: 0.32, fixedFrac: 0.18,
      articleN: 0.15, navN: 0.8, tableN: 0.55, formN: 0.55, mediaN: 0.6, metaDark: 0.5 },
    vary: { htmlBg: 0.04, meanBg: 0.05, h0: 0.12, fracDark: 0.1, contrast: 0.06, satMean: 0.1,
      satHigh: 0.1, colorful: 0.1, smallUi: 0.08, fixedFrac: 0.06, metaDark: 0.35 },
    y: [0, 0.5, 0.25, 0.01, 0.67, 0.16],
  },
  {
    // Mista: header/menu escuro com corpo claro (ou secoes bem contrastantes)
    name: "MIXED", weight: 0.13,
    f: { htmlBg: 0.55, meanBg: 0.55, h0: 0.2, h1: 0.15, h2: 0.1, h3: 0.08, h4: 0.08, h6: 0.15, h7: 0.3,
      fracWithBg: 0.45, fracDark: 0.35, fracLight: 0.35,
      textLum: 0.3, lowContrast: 0.15, contrast: 0.6, satMean: 0.25, satHigh: 0.25, colorful: 0.35,
      imgFrac: 0.06, bgImgFrac: 0.1, mono: 0.1, fontMean: 0.55, titleFrac: 0.15, smallUi: 0.22, fixedFrac: 0.15,
      articleN: 0.45, navN: 0.65, tableN: 0.3, formN: 0.4, mediaN: 0.35, metaDark: 0.25 },
    vary: { htmlBg: 0.12, meanBg: 0.1, fracDark: 0.1, fracLight: 0.1, lowContrast: 0.06,
      colorful: 0.08, titleFrac: 0.08, metaDark: 0.2 },
    y: [1, 0.4, 0.375, 0.1, 0.5, 0.05],
  },
];

// ---------------------------------------------------------------- utilidades

let seed = 0x2f6e2b1;
function rnd() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967295); }
const uni = (lo, hi) => lo + (hi - lo) * rnd();
const jit = (std) => (rnd() * 2 - 1) * std;
const c01 = (x) => Math.min(1, Math.max(0, x));

function archVector(arch) {
  const x = new Array(IN).fill(0);
  for (const [k, v] of Object.entries(arch.f)) x[IDX[k]] = v;
  return x;
}

function sampleOne() {
  let r = rnd() * ARCHETYPES.reduce((s, a) => s + a.weight, 0);
  let arch = ARCHETYPES[0];
  for (const a of ARCHETYPES) { r -= a.weight; if (r <= 0) { arch = a; break; } }
  const x = archVector(arch).map((v) => c01(v + jit(0.02)));
  for (const [k, amp] of Object.entries(arch.vary)) x[IDX[k]] = c01(x[IDX[k]] + jit(amp));
  const y = arch.y.slice();
  if (arch.name === "DARK") {
    y[4] = c01(Math.max(0.3, 0.55 - x[IDX.htmlBg] * 3) + jit(0.05));
  } else {
    y[4] = c01(y[4] + jit(0.03));
  }
  return { x, y };
}

// ---------------------------------------------------------------- rede (alocacoes fixas)

const dims = [IN, H1, H2, OUT];
const W = [], B = [];
for (let l = 0; l < dims.length - 1; l++) {
  W.push(Array.from({ length: dims[l + 1] }, () => Array.from({ length: dims[l] }, () => uni(-0.3, 0.3))));
  B.push(new Array(dims[l + 1]).fill(0));
}
const acts = [new Array(IN).fill(0), new Array(H1).fill(0), new Array(H2).fill(0), new Array(OUT).fill(0)];
const delta = [new Array(H1).fill(0), new Array(H2).fill(0), new Array(OUT).fill(0)];

function forward(x) {
  for (let i = 0; i < IN; i++) acts[0][i] = x[i];
  for (let i = 0; i < H1; i++) { let z = B[0][i]; const row = W[0][i]; for (let k = 0; k < IN; k++) z += row[k] * x[k]; acts[1][i] = Math.tanh(z); }
  for (let i = 0; i < H2; i++) { let z = B[1][i]; const row = W[1][i]; for (let k = 0; k < H1; k++) z += row[k] * acts[1][k]; acts[2][i] = Math.tanh(z); }
  for (let i = 0; i < OUT; i++) { let z = B[2][i]; const row = W[2][i]; for (let k = 0; k < H2; k++) z += row[k] * acts[2][k]; acts[3][i] = 1 / (1 + Math.exp(-z)); }
}
function trainStep(x, y, lr) {
  forward(x);
  for (let o = 0; o < OUT; o++) {
    const p = acts[3][o];
    delta[2][o] = (p - y[o]) * p * (1 - p);
  }
  for (let h = 0; h < H2; h++) {
    let d = 0; for (let o = 0; o < OUT; o++) d += W[2][o][h] * delta[2][o];
    delta[1][h] = d * (1 - acts[2][h] ** 2);
  }
  for (let o = 0; o < OUT; o++) { const row = W[2][o]; for (let h = 0; h < H2; h++) row[h] -= lr * delta[2][o] * acts[2][h]; B[2][o] -= lr * delta[2][o]; }
  for (let k = 0; k < H1; k++) {
    let d = 0; for (let h = 0; h < H2; h++) d += W[1][h][k] * delta[1][h];
    delta[0][k] = d * (1 - acts[1][k] ** 2);
  }
  for (let h = 0; h < H2; h++) { const row = W[1][h]; for (let k = 0; k < H1; k++) row[k] -= lr * delta[1][h] * acts[1][k]; B[1][h] -= lr * delta[1][h]; }
  for (let k = 0; k < H1; k++) { const row = W[0][k]; for (let j = 0; j < IN; j++) row[j] -= lr * delta[0][k] * acts[0][j]; B[0][k] -= lr * delta[0][k]; }
}
function decide(x) { forward(x); return acts[3].slice(); }

// ---------------------------------------------------------------- treino

const N = 600, EPOCHS = 220;
for (let e = 0; e < EPOCHS; e++) {
  const lr = e < 150 ? 0.1 : 0.04;
  let tot = 0;
  for (let i = 0; i < N; i++) {
    const { x, y } = sampleOne();
    forward(x);
    let loss = 0;
    for (let o = 0; o < OUT; o++) loss += (acts[3][o] - y[o]) ** 2;
    tot += loss / OUT;
    trainStep(x, y, lr);
  }
  if (e === 0 || (e + 1) % 60 === 0) console.log(`epoca ${e + 1}: loss=${(tot / N).toFixed(5)}`);
}

// ---------------------------------------------------------------- validacao

let fails = 0;
for (const arch of ARCHETYPES) {
  const p = decide(archVector(arch));
  const invert = p[0] > 0.5;
  const ok = invert === (arch.y[0] > 0.5);
  if (!ok) fails++;
  const line = [
    `invert=${invert ? "SIM" : "nao"}(alvo ${arch.y[0] > 0.5 ? "SIM" : "nao"})`,
    p[0] > 0.5
      ? `brilho=${(0.6 + 0.8 * p[1]).toFixed(2)} contraste=${(0.6 + 0.8 * p[2]).toFixed(2)}`
      : `dim=${(0.7 + 0.3 * p[4]).toFixed(2)} contraste=${(0.9 + 0.25 * p[2]).toFixed(2)}`,
    `sepia=${(0.5 * p[3]).toFixed(2)}`,
    `tint=${(0.25 * p[5]).toFixed(2)}`,
  ].join("  ");
  console.log(`${ok ? "OK " : "ERR"} ${arch.name.padEnd(11)} ${line}`);
}
let acc = 0, M = 5000;
for (let i = 0; i < M; i++) {
  const { x, y } = sampleOne();
  if ((decide(x)[0] > 0.5 ? 1 : 0) === y[0]) acc++;
}
console.log(`acerto decisao inverter: ${(100 * acc / M).toFixed(2)}%`);
if (fails > 0 || acc / M < 0.99) { console.error("treino insatisfatorio, pesos NAO salvos"); process.exit(1); }

// ---------------------------------------------------------------- pesos

const r5 = (v) => Math.round(v * 1e5) / 1e5;
const weights = {
  dims: [IN, H1, H2, OUT],
  W: W.map((m) => m.map((row) => row.map(r5))),
  b: B.map((v) => v.map(r5)),
};

const header = `// Pesos do modelo v2 da rede de paginas (32 features -> 24 -> 16 -> 6 saidas).
// ARQUIVO GERADO por tools/train-page-model.js - nao editar a mao.
// Saidas: [inverter, brilho, contraste, sepia, dim, tint]
//   invert:  brilho = 0.6+0.8*b | contraste = 0.6+0.8*c | sepia = 0.5*s | tint = 0.25*t
//   retoque: brilho = 0.7+0.3*dim | contraste = 0.9+0.25*c | sepia = 0.5*s | tint = 0.25*t
"use strict";

globalThis.DARL_PAGE_WEIGHTS = `;
const out = header + JSON.stringify(weights) + ";\n";
const dest = path.join(__dirname, "..", "weights-page.js");
fs.writeFileSync(dest, out);
console.log(`pesos salvos em ${dest} (${out.length} bytes)`);
