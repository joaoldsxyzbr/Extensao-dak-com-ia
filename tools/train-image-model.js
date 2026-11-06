// Treinador da rede de imagens (Extensão Dark com IA v3 - pipeline nnlab).
// Executar: node tools/train-image-model.js
// Gera ../weights-images.js (com temperatura calibrada).
//
// Rede: [6, 12, 1]. Decide por imagem: manter invertida (icone escuro com
// transparencia -> fica claro e visivel) ou restaurar as cores originais.
// Entradas: [fracTransp, lumMedia, lumDesvio, satMedia, fracEscura, fracClara]
"use strict";

const path = require("path");
const lab = require("./nnlab.js");

const DIMS = [6, 12, 1];

// keep=1 -> manter invertida. Regra do professor:
// transparencia significativa E conteudo escuro; imagens opacas sempre restauram.
const ARCH = [
  { name: "ICON_DARK", w: 0.21, keep: 1, // icone/logo escuro com transparencia
    f: [0.55, 0.14, 0.12, 0.18, 0.72, 0.04],
    vary: { 0: 0.16, 1: 0.09, 2: 0.06, 3: 0.13, 4: 0.14, 5: 0.04 } },
  { name: "ICON_DARK_LOWTRANS", w: 0.1, keep: 1, // borda do case: pouca transparencia
    f: [0.3, 0.2, 0.1, 0.2, 0.6, 0.05],
    vary: { 0: 0.08, 1: 0.05, 2: 0.03, 3: 0.06, 4: 0.08 } },
  { name: "ICON_HALF", w: 0.08, keep: 1, // icone semitransparente com conteudo medio-escuro
    f: [0.45, 0.25, 0.12, 0.20, 0.50, 0.06],
    vary: { 0: 0.10, 1: 0.06, 2: 0.04, 3: 0.06, 4: 0.08 } },
  { name: "ICON_LIGHT", w: 0.17, keep: 0, // icone claro transparente: restaurar
    f: [0.55, 0.85, 0.10, 0.10, 0.03, 0.78],
    vary: { 0: 0.16, 1: 0.07, 2: 0.05, 3: 0.08, 5: 0.13 } },
  { name: "LOGO_COLOR", w: 0.10, keep: 0, // logo colorido transparente: restaurar
    f: [0.45, 0.55, 0.18, 0.62, 0.15, 0.20],
    vary: { 0: 0.15, 1: 0.12, 2: 0.06, 3: 0.12, 4: 0.08, 5: 0.09 } },
  { name: "PHOTO_DARK", w: 0.12, keep: 0, // foto escura opaca (regressao v1): restaurar
    f: [0.01, 0.22, 0.10, 0.30, 0.82, 0.01],
    vary: { 1: 0.06, 2: 0.035, 3: 0.10, 4: 0.08 } },
  { name: "PHOTO", w: 0.14, keep: 0, // foto/screenshot opaco em geral: restaurar
    f: [0.01, 0.45, 0.20, 0.40, 0.25, 0.30],
    vary: { 1: 0.18, 2: 0.08, 3: 0.15, 4: 0.13, 5: 0.13 } },
  { name: "EMOJI", w: 0.05, keep: 0, // emoji/sticker colorido opaco: restaurar
    f: [0.00, 0.62, 0.15, 0.75, 0.05, 0.50],
    vary: { 1: 0.08, 3: 0.08, 5: 0.10 } },
  { name: "SCREENSHOT_LIGHT", w: 0.05, keep: 0, // screenshot claro opaco: restaurar
    f: [0.00, 0.80, 0.25, 0.20, 0.02, 0.70],
    vary: { 1: 0.06, 2: 0.08, 5: 0.08 } },
];

const c01 = (v) => Math.min(1, Math.max(0, v));

function genDataset(n, seed) {
  const rnd = lab.xorshift(seed);
  const data = [];
  for (let i = 0; i < n; i++) {
    let r = rnd();
    let a = ARCH[0];
    for (const arch of ARCH) { r -= arch.w; if (r <= 0) { a = arch; break; } }
    const x = a.f.slice();
    for (const [idxS, amp] of Object.entries(a.vary)) x[Number(idxS)] += (rnd() * 2 - 1) * amp;
    for (let j = 0; j < x.length; j++) x[j] = c01(x[j] + (rnd() * 2 - 1) * 0.015);
    data.push({ x, y: [a.keep] });
  }
  return data;
}

console.log("Treinando rede de imagens [6, 12, 1] com pipeline nnlab:");
const trainData = genDataset(3000, 888);
const valData = genDataset(800, 444);
console.log(`  dataset: ${trainData.length} treino / ${valData.length} validacao (holdout)`);

const net = lab.createNet(DIMS, lab.xorshift(22222));
const result = lab.trainNet(net, trainData, valData, {
  epochs: 150, batchSize: 32, lrMax: 0.01, lrMin: 0.0002,
  weightDecay: 0.0005, patience: 40, log: true, logEvery: 30,
});
console.log(`  melhor val loss: ${result.bestValLoss.toFixed(5)}`);

const CASES = [
  ["icone escuro transparente", [0.6, 0.15, 0.15, 0.15, 0.78, 0.03], 1],
  ["icone claro transparente", [0.6, 0.85, 0.12, 0.12, 0.03, 0.78], 0],
  ["foto media opaca", [0.0, 0.5, 0.22, 0.42, 0.25, 0.25], 0],
  ["foto muito escura opaca (regressao v1)", [0.0, 0.21, 0.09, 0.32, 0.89, 0.0], 0],
  ["logo colorido transparente", [0.45, 0.55, 0.18, 0.6, 0.2, 0.2], 0],
  ["icone escuro pouca transparencia", [0.3, 0.2, 0.1, 0.2, 0.6, 0.05], 1],
  ["icone semitransparente medio-escuro", [0.45, 0.25, 0.12, 0.2, 0.5, 0.06], 1],
  ["emoji colorido opaco", [0.0, 0.62, 0.15, 0.75, 0.05, 0.5], 0],
  ["screenshot claro opaco", [0.0, 0.8, 0.25, 0.2, 0.02, 0.7], 0],
];
let fails = 0;
for (const [name, x, expected] of CASES) {
  const p = lab.forward(result.net, x).p[0];
  const got = p > 0.5 ? 1 : 0;
  if (got !== expected) fails++;
  console.log(`  ${got === expected ? "OK " : "ERR"} ${name}: keep=${got} (p=${p.toFixed(3)})`);
}
let acc = 0;
for (const s of valData) if ((lab.forward(result.net, s.x).p[0] > 0.5) === (s.y[0] > 0.5)) acc++;
console.log(`  acerto geral (holdout): ${(100 * acc / valData.length).toFixed(2)}%`);

const temp = lab.fitTemperature(result.net, valData, 0);
console.log(`  temperatura calibrada (holdout): T=${temp}`);

if (fails > 0 || acc / valData.length < 0.995) {
  console.error("treino insatisfatorio: pesos NAO salvos");
  process.exit(1);
}

const weights = lab.serializeNet(result.net, temp);
const dest = path.join(__dirname, "..", "weights-images.js");
const header = `// Pesos da rede de imagens ([6, 12, 1]) + temperatura calibrada.
// ARQUIVO GERADO por tools/train-image-model.js (pipeline nnlab: Adam, cosine LR,
// weight decay, holdout, early stopping, calibracao de temperatura).
// Decide por imagem: restaurar as cores originais ou manter invertida
// (icones/logos escuros com transparencia ficam claros e visiveis no tema escuro).
// Entradas: [fracTransp, lumMedia, lumDesvio, satMedia, fracEscura, fracClara]
"use strict";

globalThis.DARL_IMAGE_WEIGHTS = `;
const bytes = lab.saveWeightsFile(dest, header, weights);
console.log(`pesos salvos em ${dest} (${bytes} bytes)`);
