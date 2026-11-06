// Treinador do modelo de paginas (Extensão Dark com IA v3 - pipeline nnlab).
// Executar: node tools/train-page-model.js
// Gera ../weights-page.js (com temperatura calibrada).
//
// Rede: 32 -> 24 -> 16 -> 6 saidas:
//   [inverter, brilho, contraste, sepia, dim, tint]
// Features (32), em ordem:
//   0 htmlBg, 1 meanBg | 2-9 histograma de luminancia (8 faixas)
//   10 fracWithBg, 11 fracDark, 12 fracLight | 13 textLum, 14 lowContrast, 15 contrast
//   16 satMean, 17 satHigh, 18 colorful | 19 imgFrac, 20 bgImgFrac, 21 mono
//   22 fontMean, 23 titleFrac, 24 smallUi, 25 fixedFrac
//   26 articleN, 27 navN, 28 tableN, 29 formN, 30 mediaN, 31 metaDark
"use strict";

const path = require("path");
const lab = require("./nnlab.js");

const IN = 32, H1 = 24, H2 = 16, OUT = 6;
const DIMS = [IN, H1, H2, OUT];

const ORDER2 = {
  htmlBg: 0, meanBg: 1, h0: 2, h1: 3, h2: 4, h3: 5, h4: 6, h5: 7, h6: 8, h7: 9,
  fracWithBg: 10, fracDark: 11, fracLight: 12, textLum: 13, lowContrast: 14, contrast: 15,
  satMean: 16, satHigh: 17, colorful: 18, imgFrac: 19, bgImgFrac: 20, mono: 21,
  fontMean: 22, titleFrac: 23, smallUi: 24, fixedFrac: 25,
  articleN: 26, navN: 27, tableN: 28, formN: 29, mediaN: 30, metaDark: 31,
};

// Familias: misturas (interpolacao) so dentro da mesma familia, para nao
// ambiguar a saida "inverter". LIGHT_FAMILY = inverter; DARK_FAMILY = retoque.
const ARCHETYPES = [
  { name: "LIGHT_WEB", w: 0.31, family: "LIGHT", // site claro comum
    f: { htmlBg:0.95, meanBg:0.9, h6:0.05, h7:0.75, fracWithBg:0.35, fracDark:0.06, fracLight:0.78,
      textLum:0.13, lowContrast:0.05, contrast:0.85, satMean:0.12, satHigh:0.08, colorful:0.12,
      imgFrac:0.05, bgImgFrac:0.08, mono:0.08, fontMean:0.55, titleFrac:0.05, smallUi:0.2, fixedFrac:0.08,
      articleN:0.4, navN:0.6, tableN:0.15, formN:0.3, mediaN:0.2, metaDark:0.02 },
    vary: { htmlBg:0.04, meanBg:0.05, h7:0.15, fracWithBg:0.1, fracDark:0.1, fracLight:0.06,
      textLum:0.05, contrast:0.05, satMean:0.05, satHigh:0.06, colorful:0.07, mono:0.1,
      fontMean:0.1, titleFrac:0.04, smallUi:0.1 },
    y: [1, 0.44, 0.44, 0.08, 0.5, 0.02] },
  { name: "HARSH_WHITE", w: 0.14, family: "LIGHT", // pagina branca dura (docs, login)
    f: { htmlBg:1.0, meanBg:0.97, h7:0.85, fracWithBg:0.3, fracDark:0.01, fracLight:0.93,
      textLum:0.05, lowContrast:0.02, contrast:0.92, satMean:0.05, satHigh:0.02, colorful:0.05,
      imgFrac:0.03, bgImgFrac:0.25, mono:0.5, fontMean:0.5, titleFrac:0.02, smallUi:0.25, fixedFrac:0.02,
      articleN:0.3, navN:0.6, tableN:0.25, formN:0.2, mediaN:0.02, metaDark:0.02 },
    vary: { h7:0.1, fracWithBg:0.08, textLum:0.03, contrast:0.04, mono:0.15, smallUi:0.08, formN:0.15 },
    y: [1, 0.27, 0.4, 0.12, 0.5, 0.2] },
  { name: "CREAM", w: 0.10, family: "LIGHT", // noticias/leitores creme
    f: { htmlBg:0.9, meanBg:0.88, h6:0.05, h7:0.6, fracWithBg:0.4, fracDark:0.05, fracLight:0.7,
      textLum:0.25, lowContrast:0.12, contrast:0.75, satMean:0.35, satHigh:0.3, colorful:0.5,
      imgFrac:0.04, bgImgFrac:0.06, mono:0.06, fontMean:0.55, titleFrac:0.12, smallUi:0.15, fixedFrac:0.05,
      articleN:0.7, navN:0.5, tableN:0.1, formN:0.15, mediaN:0.1, metaDark:0.05 },
    vary: { htmlBg:0.04, h7:0.12, fracLight:0.08, textLum:0.08, lowContrast:0.05,
      satMean:0.08, satHigh:0.1, colorful:0.1, titleFrac:0.05 },
    y: [1, 0.44, 0.4, 0.04, 0.5, 0.3] },
  { name: "MIXED", w: 0.13, family: "LIGHT", // header escuro + corpo claro
    f: { htmlBg:0.55, meanBg:0.55, h0:0.2, h1:0.15, h2:0.1, h3:0.08, h4:0.08, h6:0.15, h7:0.3,
      fracWithBg:0.45, fracDark:0.35, fracLight:0.35,
      textLum:0.3, lowContrast:0.15, contrast:0.6, satMean:0.25, satHigh:0.25, colorful:0.35,
      imgFrac:0.06, bgImgFrac:0.1, mono:0.1, fontMean:0.55, titleFrac:0.15, smallUi:0.22, fixedFrac:0.15,
      articleN:0.45, navN:0.65, tableN:0.3, formN:0.4, mediaN:0.35, metaDark:0.25 },
    vary: { htmlBg:0.12, meanBg:0.1, fracDark:0.1, fracLight:0.1, lowContrast:0.06,
      colorful:0.08, titleFrac:0.08, metaDark:0.2 },
    y: [1, 0.4, 0.375, 0.1, 0.5, 0.05] },
  { name: "DARK", w: 0.22, family: "DARK", // site ja escuro
    f: { htmlBg:0.07, meanBg:0.11, h0:0.55, h1:0.25, fracWithBg:0.5, fracDark:0.82, fracLight:0.02,
      textLum:0.8, lowContrast:0.07, contrast:0.78, satMean:0.28, satHigh:0.15, colorful:0.2,
      imgFrac:0.05, bgImgFrac:0.05, mono:0.05, fontMean:0.55, titleFrac:0.05, smallUi:0.3, fixedFrac:0.1,
      articleN:0.35, navN:0.6, tableN:0.2, formN:0.35, mediaN:0.5, metaDark:0.8 },
    vary: { htmlBg:0.045, meanBg:0.05, h0:0.15, h1:0.1, fracDark:0.1, textLum:0.07,
      contrast:0.05, satMean:0.06, satHigh:0.08, smallUi:0.1, metaDark:0.25 },
    y: [0, 0.5, 0.2, 0.02, 0.45, 0.04] }, // dim real calculado por amostra
  { name: "BLUE_DASH", w: 0.10, family: "DARK", // dashboard escuro saturado
    f: { htmlBg:0.1, meanBg:0.15, h0:0.5, h1:0.3, fracWithBg:0.6, fracDark:0.75, fracLight:0.03,
      textLum:0.85, lowContrast:0.05, contrast:0.8, satMean:0.6, satHigh:0.7, colorful:0.7,
      imgFrac:0.04, bgImgFrac:0.08, mono:0.08, fontMean:0.5, titleFrac:0.03, smallUi:0.32, fixedFrac:0.18,
      articleN:0.15, navN:0.8, tableN:0.55, formN:0.55, mediaN:0.6, metaDark:0.5 },
    vary: { htmlBg:0.04, meanBg:0.05, h0:0.12, fracDark:0.1, contrast:0.06, satMean:0.1,
      satHigh:0.1, colorful:0.1, smallUi:0.08, fixedFrac:0.06, metaDark:0.35 },
    y: [0, 0.5, 0.25, 0.01, 0.67, 0.16] },
];

const rnd = lab.xorshift(20260213);
const c01 = (v) => Math.min(1, Math.max(0, v));
const jit = (s) => (rnd() * 2 - 1) * s;

function archVector(arch) {
  const x = new Array(IN).fill(0);
  for (const [k, v] of Object.entries(arch.f)) x[ORDER2[k]] = v;
  return x;
}

function pickArch() {
  let r = rnd() * ARCHETYPES.reduce((s, a) => s + a.w, 0);
  for (const a of ARCHETYPES) { r -= a.w; if (r <= 0) return a; }
  return ARCHETYPES[0];
}

// Datasets: treino e holdout com sementes e jitter independentes.
// Interpolacao em 15% das amostras (dentro da mesma familia): misturar demais
// dilui os centros dos arquétipos verificados nos testes.
function genDataset(n, seed) {
  const rndLocal = lab.xorshift(seed);
  const data = [];
  const localSample = () => {
    let a = pickArch(); // selecao de arquétipo pela cadeia global (determinista)
    let x, y;
    let mixed = false;
    const localJit = (s) => (rndLocal() * 2 - 1) * s;
    if (rndLocal() < 0.15) {
      mixed = true;
      const same = ARCHETYPES.filter((o) => o !== a && o.family === a.family);
      const b = same[Math.floor(rndLocal() * same.length)] || a;
      const alpha = rndLocal();
      x = archVector(a).map((v, i) => v * alpha + archVector(b)[i] * (1 - alpha));
      y = a.y.map((v, i) => v * alpha + b.y[i] * (1 - alpha));
      // mistura com DARK: dim interpolado entre o alvo do parceiro e a formula
      // do DARK avaliada no htmlBg do ponto misturado (nao pode sobrescrever BLUE_DASH).
      const blend = Math.max(0.3, 0.55 - x[ORDER2.htmlBg] * 3);
      const aDim = a.name === "DARK" ? blend : a.y[4];
      const bDim = b.name === "DARK" ? blend : b.y[4];
      y[4] = aDim * alpha + bDim * (1 - alpha);
    } else {
      x = archVector(a);
      y = a.y.slice();
    }
    for (const [k, amp] of Object.entries(a.vary)) x[ORDER2[k]] = c01(x[ORDER2[k]] + localJit(amp));
    x.forEach((v, i) => { x[i] = c01(v + localJit(0.02)); });
    y.forEach((v, i) => { y[i] = c01(v + localJit(0.02)); });
    // DARK puro: dim depende da escuridao real do fundo da amostra.
    if (a.name === "DARK" && !mixed) {
      y[4] = c01(Math.max(0.3, 0.55 - x[ORDER2.htmlBg] * 3) + localJit(0.05));
    }
    return { x, y };
  };
  for (let i = 0; i < n; i++) data.push(localSample());
  return data;
}

console.log("Treinando rede de paginas [32, 24, 16, 6] com pipeline nnlab:");
const trainData = genDataset(4000, 101);
const valData = genDataset(1000, 909);
console.log(`  dataset: ${trainData.length} treino / ${valData.length} validacao (holdout)`);

const net = lab.createNet(DIMS, rnd);
const result = lab.trainNet(net, trainData, valData, {
  epochs: 200, batchSize: 32, lrMax: 0.01, lrMin: 0.0002,
  weightDecay: 0.0005, patience: 60, log: true, logEvery: 40,
});
console.log(`  melhor val loss: ${result.bestValLoss.toFixed(5)}`);

// acerto de decisao + casos-chave
function decide(x) { return lab.forward(result.net, x).p; }
let acc = 0;
for (const s of valData) if ((decide(s.x)[0] > 0.5) === (s.y[0] > 0.5)) acc++;
console.log(`  acerto decisao inverter (holdout): ${(100 * acc / valData.length).toFixed(2)}%`);

let fails = 0;
for (const a of ARCHETYPES) {
  const p = decide(archVector(a));
  const inv = p[0] > 0.5;
  const ok = inv === (a.y[0] > 0.5);
  if (!ok) fails++;
  const line = inv
    ? `brilhoInv=${(0.6 + 0.8 * p[1]).toFixed(2)} contrasteInv=${(0.6 + 0.8 * p[2]).toFixed(2)}`
    : `dim=${(0.7 + 0.3 * p[4]).toFixed(2)} tint=${(0.25 * p[5]).toFixed(2)}`;
  console.log(`  ${ok ? "OK " : "ERR"} ${a.name.padEnd(11)} invert=${inv ? "SIM" : "nao"} ${line}`);
}

const temp = lab.fitTemperature(result.net, valData, 0);
console.log(`  temperatura calibrada (holdout): T=${temp}`);

if (fails > 0 || acc / valData.length < 0.995) {
  console.error("treino insatisfatorio: pesos NAO salvos");
  process.exit(1);
}

const weights = lab.serializeNet(result.net, temp);
const dest = path.join(__dirname, "..", "weights-page.js");
const header = `// Pesos do modelo de paginas (32 -> 24 -> 16 -> 6) + temperatura calibrada.
// ARQUIVO GERADO por tools/train-page-model.js (pipeline nnlab: Adam, cosine LR,
// weight decay, holdout, early stopping, calibracao de temperatura).
// Saidas: [inverter, brilho, contraste, sepia, dim, tint]
//   invert:  brilho = 0.6+0.8*b | contraste = 0.6+0.8*c | sepia = 0.5*s | tint = 0.25*t
//   retoque: brilho = 0.7+0.3*dim | contraste = 0.9+0.25*c | sepia = 0.5*s | tint = 0.25*t
"use strict";

globalThis.DARL_PAGE_WEIGHTS = `;
const bytes = lab.saveWeightsFile(dest, header, weights);
console.log(`pesos salvos em ${dest} (${bytes} bytes)`);
