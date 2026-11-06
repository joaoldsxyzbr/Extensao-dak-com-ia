// Treinador da rede de regioes (Darl Dark v3 - pipeline nnlab).
// Executar: node tools/train-region-model.js
// Gera ../weights-region.js (com temperatura calibrada).
//
// Rede: [8, 12, 1]. Decide por bloco escuro em pagina invertida: manter
// original (dd-region) ou seguir a inversao da pagina.
// Entradas: [lum, sat, textLum, contrast, areaFrac, isFixed, hasBgImg, childMediaFrac]
"use strict";

const path = require("path");
const lab = require("./nnlab.js");

const DIMS = [8, 12, 1];

// keep=1 -> manter original (bloco escuro preservado)
const ARCH = [
  { name: "DARK_HEADER", w: 0.22, keep: 1,
    f: [0.10, 0.30, 0.85, 0.80, 0.12, 0.80, 0.00, 0.05],
    vary: { 0: 0.05, 1: 0.15, 2: 0.06, 3: 0.06, 4: 0.06, 5: 0.25 } },
  { name: "DARK_FOOTER", w: 0.15, keep: 1,
    f: [0.08, 0.20, 0.80, 0.75, 0.08, 0.00, 0.00, 0.03],
    vary: { 0: 0.04, 2: 0.05, 3: 0.05, 4: 0.04 } },
  { name: "DARK_HERO", w: 0.18, keep: 1,
    f: [0.25, 0.35, 0.90, 0.70, 0.45, 0.00, 1.00, 0.05],
    vary: { 0: 0.12, 1: 0.15, 2: 0.06, 3: 0.08, 4: 0.20 } },
  { name: "DARK_CARD", w: 0.20, keep: 1,
    f: [0.12, 0.25, 0.85, 0.80, 0.05, 0.00, 0.00, 0.02],
    vary: { 0: 0.05, 1: 0.12, 2: 0.06, 3: 0.06, 4: 0.03 } },
  { name: "MID_PANEL", w: 0.10, keep: 0,
    f: [0.40, 0.15, 0.50, 0.50, 0.20, 0.00, 0.00, 0.05],
    vary: { 0: 0.05, 1: 0.10, 2: 0.10, 3: 0.10, 4: 0.10 } },
  { name: "LIGHT_CONTENT", w: 0.15, keep: 0,
    f: [0.85, 0.10, 0.12, 0.85, 0.50, 0.00, 0.00, 0.05],
    vary: { 0: 0.08, 1: 0.08, 2: 0.05, 3: 0.05, 4: 0.25 } },
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
    x[5] = x[5] > 0.5 && a.f[5] >= 0.5 ? 1 : rnd() < a.f[5] ? 1 : 0; // binariza isFixed
    for (let j = 0; j < x.length; j++) x[j] = c01(x[j] + (rnd() * 2 - 1) * 0.015);
    data.push({ x, y: [a.keep] });
  }
  return data;
}

console.log("Treinando rede de regioes [8, 12, 1] com pipeline nnlab:");
const trainData = genDataset(3000, 77);
const valData = genDataset(800, 555);
console.log(`  dataset: ${trainData.length} treino / ${valData.length} validacao (holdout)`);

const net = lab.createNet(DIMS, lab.xorshift(31337));
const result = lab.trainNet(net, trainData, valData, {
  epochs: 150, batchSize: 32, lrMax: 0.01, lrMin: 0.0002,
  weightDecay: 0.0005, patience: 40, log: true, logEvery: 30,
});
console.log(`  melhor val loss: ${result.bestValLoss.toFixed(5)}`);

let fails = 0;
for (const a of ARCH) {
  const p = lab.forward(result.net, a.f).p[0];
  const got = p > 0.5 ? 1 : 0;
  if (got !== a.keep) fails++;
  console.log(`  ${got === a.keep ? "OK " : "ERR"} ${a.name.padEnd(13)} keep=${got} (p=${p.toFixed(3)})`);
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
const dest = path.join(__dirname, "..", "weights-region.js");
const header = `// Pesos da rede de regioes ([8, 12, 1]) + temperatura calibrada.
// ARQUIVO GERADO por tools/train-region-model.js (pipeline nnlab: Adam, cosine LR,
// weight decay, holdout, early stopping, calibracao de temperatura).
// Decide por bloco escuro em pagina invertida: manter original (dd-region) ou seguir.
// Entradas: [lum, sat, textLum, contrast, areaFrac, isFixed, hasBgImg, childMediaFrac]
"usestrict";

globalThis.DARL_REGION_WEIGHTS = `
  .replace('"usestrict"', '"use strict"');
const bytes = lab.saveWeightsFile(dest, header, weights);
console.log(`pesos salvos em ${dest} (${bytes} bytes)`);
