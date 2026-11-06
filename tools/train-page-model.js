// Treinador do modelo de paginas (Extensão Dark com IA v3 - pipeline nnlab).
// Executar: node tools/train-page-model.js
// Gera ../weights-page.js (com temperatura calibrada).
//
// Rede: 32 -> 32 -> 24 -> 6 saidas:
//   [inverter, brilho, contraste, sepia, dim, tint]
// Features (32), em ordem:
//   0 htmlBg, 1 meanBg | 2-9 histograma de luminancia (8 faixas)
//   10 fracWithBg, 11 fracDark, 12 fracLight | 13 textLum, 14 lowContrast, 15 contrast
//   16 satMean, 17 satHigh, 18 colorful | 19 imgFrac, 20 bgImgFrac, 21 mono
//   22 fontMean, 23 titleFrac, 24 smallUi, 25 fixedFrac
//   26 articleN, 27 navN, 28 tableN, 29 formN, 30 mediaN, 31 metaDark
"use strict";

const dataset = require("./page-dataset.js");
const { ARCHETYPES, DIMS, genDataset, archVector, rnd } = dataset;
const lab = require("./nnlab.js");
const path = require("path");

console.log("Treinando rede de paginas [32, 32, 24, 6] com pipeline nnlab:");
const trainData = genDataset(6000, 101);
const valData = genDataset(1500, 909);
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
const header = `// Pesos do modelo de paginas (32 -> 32 -> 24 -> 6) + temperatura calibrada.
// ARQUIVO GERADO por tools/train-page-model.js (pipeline nnlab: Adam, cosine LR,
// weight decay, holdout, early stopping, calibracao de temperatura).
// Saidas: [inverter, brilho, contraste, sepia, dim, tint]
//   invert:  brilho = 0.6+0.8*b | contraste = 0.6+0.8*c | sepia = 0.5*s | tint = 0.25*t
//   retoque: brilho = 0.7+0.3*dim | contraste = 0.9+0.25*c | sepia = 0.5*s | tint = 0.25*t
"use strict";

globalThis.DARL_PAGE_WEIGHTS = `;
const bytes = lab.saveWeightsFile(dest, header, weights);
console.log(`pesos salvos em ${dest} (${bytes} bytes)`);
