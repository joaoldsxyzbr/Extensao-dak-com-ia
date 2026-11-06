// Treinador GBDT do modelo de paginas (Extensão Dark com IA v4).
// Executar: node tools/train-page-gbdt.js [--write]
//
// Treina o gradient boosting multi-saida (tools/gbdt.js, JS puro) no MESMO
// dataset do pipeline nnlab (tools/page-dataset.js: 15 arquetipos + jitter,
// hoje sinteticos; registros reais do crawler podem ser somados aqui).
// Portao de elegibilidade identico ao do train-page-model.js: holdout >=
// 99.5%, todos os arquetipos certos e casos-chave decisivos. Com --write,
// grava ../weights-page.js (floresta + temperatura). Sem --write, apenas
// treina e verifica (e o CI roda assim a cada push).
"use strict";

const fs = require("fs");
const path = require("path");
const dataset = require("./page-dataset.js");
const gbdt = require("./gbdt.js");
const { ARCHETYPES, genDataset, archVector } = dataset;

// ---- mesmos dados, mesma ordem de chamadas que o train-page-model.js
const trainData = genDataset(6000, 101);
const valData = genDataset(1500, 909);
console.log(`GBDT de paginas: ${trainData.length} treino / ${valData.length} validacao`);

const t0 = Date.now();
const model = gbdt.train(trainData, valData, {
  nOut: 6, rounds: 80, lr: 0.12, maxDepth: 3, minLeaf: 12, colSample: 8, seed: 7,
  log: true, logEvery: 20,
});
console.log(`  treino em ${((Date.now() - t0) / 1000).toFixed(1)}s, melhor rodada ${model.bestRound}, val MSE=${model.valMse.toFixed(5)}`);

// ---- gate de elegibilidade (mesma regua do train-page-model.js)
let acc = 0;
for (const s of valData) if ((model.predict(s.x)[0] > 0.5) === (s.y[0] > 0.5)) acc++;
let mse = 0;
for (const s of valData) {
  const p = model.predict(s.x);
  for (let o = 0; o < 6; o++) mse += (p[o] - s.y[o]) * (p[o] - s.y[o]);
}
mse /= valData.length * 6;
console.log(`  holdout: acuracia ${(100 * acc / valData.length).toFixed(2)}%  MSE ${mse.toFixed(5)}`);

// ---- casos-chave do test-nn.js (vetores identicos aos da suite)
const ORDER = [
  "htmlBg", "meanBg", "h0", "h1", "h2", "h3", "h4", "h5", "h6", "h7",
  "fracWithBg", "fracDark", "fracLight", "textLum", "lowContrast", "contrast",
  "satMean", "satHigh", "colorful", "imgFrac", "bgImgFrac", "mono", "fontMean",
  "titleFrac", "smallUi", "fixedFrac", "articleN", "navN", "tableN", "formN", "mediaN", "metaDark",
];
const IDX = Object.fromEntries(ORDER.map((k, i) => [k, i]));
function vec(fields) {
  const x = new Array(32).fill(0);
  for (const [k, v] of Object.entries(fields)) x[IDX[k]] = v;
  return x;
}
const PRADO = vec({ htmlBg: 0.9, meanBg: 0.55, h0: 0.28, h1: 0.1, h6: 0.12, h7: 0.32,
  fracWithBg: 0.55, fracDark: 0.4, fracLight: 0.35, textLum: 0.45, lowContrast: 0.12,
  contrast: 0.62, satMean: 0.28, satHigh: 0.2, colorful: 0.28, imgFrac: 0.05, mono: 0.02,
  fontMean: 0.45, smallUi: 0.3, fixedFrac: 0.15, navN: 0.5, formN: 0.35, mediaN: 0.2, metaDark: 0 });
const TG = vec({ htmlBg: 0.05, meanBg: 0.09, h0: 0.5, h1: 0.3, fracWithBg: 0.5, fracDark: 0.75,
  textLum: 0.85, lowContrast: 0.04, contrast: 0.82, satMean: 0.3, satHigh: 0.25, colorful: 0.25,
  imgFrac: 0.06, mono: 0.02, fontMean: 0.45, smallUi: 0.32, fixedFrac: 0.12, navN: 0.5,
  formN: 0.35, mediaN: 0.2, metaDark: 1 });
const LIGHT = vec({ htmlBg: 0.95, meanBg: 0.9, h7: 0.75, fracWithBg: 0.35, fracLight: 0.78,
  textLum: 0.13, contrast: 0.85, satMean: 0.12, fontMean: 0.55, smallUi: 0.2 });
const DARKARCH = vec({ htmlBg: 0.07, meanBg: 0.11, h0: 0.55, h1: 0.25, fracWithBg: 0.5,
  fracDark: 0.82, textLum: 0.8, contrast: 0.78, satMean: 0.28, fontMean: 0.55,
  smallUi: 0.3, mediaN: 0.5, metaDark: 1 });

// Caso real exportado do dataLog (chat.pradoapp.com, Rocket.Chat, 06/11/2026):
// casca escura + painel branco de conteudo. Antes do arquétipo CHAT_HYBRID a
// floresta dizia "retoque" (p(inverter)=0.06) e o chat ficava claro.
const ROCKET = [
  0.202, 0.213, 0.002, 0.971, 0.008, 0.005, 0, 0.011, 0, 0.005,
  0.058, 0.972, 0.005, 0.598, 0.959, 0.398, 0.339, 0.263, 0.263, 0.011,
  0.005, 0, 0.5, 0, 0.074, 0.002, 0, 0, 0, 0, 0, 0,
];

// temperatura: calibra o logit da saida 0 contra o holdout (Guo et al.)
function fitTemp() {
  let bestT = 1, bestNll = Infinity;
  for (let T = 0.3; T <= 2.001; T += 0.02) {
    let nll = 0;
    for (const s of valData) {
      const p = Math.min(0.999, Math.max(0.001, model.predict(s.x)[0]));
      const lg = Math.log(p / (1 - p));
      const q = 1 / (1 + Math.exp(-lg / T));
      const y = s.y[0] > 0.5 ? 1 : 0;
      nll += -(y * Math.log(q + 1e-9) + (1 - y) * Math.log(1 - q + 1e-9));
    }
    if (nll < bestNll) { bestNll = nll; bestT = Math.round(T * 100) / 100; }
  }
  return bestT;
}
const gbdtTemp = fitTemp();
const cal = (p, T) => {
  const c = Math.min(0.999, Math.max(0.001, p));
  return 1 / (1 + Math.exp(-(Math.log(c / (1 - c))) / T));
};
const pradoG = cal(model.predict(PRADO)[0], gbdtTemp);
const tgG = cal(model.predict(TG)[0], gbdtTemp);
const rocketG = cal(model.predict(ROCKET)[0], gbdtTemp);
console.log(`  PRADO conf:       ${pradoG.toFixed(2)}  (min 0.75, inverter)`);
console.log(`  TELEGRAM p(inv):  ${tgG.toFixed(2)}  (max 0.25, nao inverter)`);
console.log(`  ROCKET conf:      ${rocketG.toFixed(2)}  (min 0.75, inverter)`);
console.log(`  LIGHT inverte:    ${model.predict(LIGHT)[0].toFixed(2)}`);
console.log(`  DARK nao inverte: ${model.predict(DARKARCH)[0].toFixed(2)}`);

let fails = 0;
for (const a of ARCHETYPES) {
  const inv = model.predict(archVector(a))[0] > 0.5;
  const ok = inv === (a.y[0] > 0.5);
  if (!ok) fails++;
  console.log(`  ${ok ? "OK " : "ERR"} ${a.name.padEnd(11)} invert=${inv ? "SIM" : "nao"}`);
}
console.log(`  temperatura GBDT calibrada: T=${gbdtTemp}`);

const eligible =
  fails === 0 &&
  acc / valData.length >= 0.995 &&
  mse <= 0.001 &&
  pradoG >= 0.75 && tgG <= 0.25 && rocketG >= 0.75;

if (process.argv.includes("--write")) {
  if (!eligible) {
    console.error("GBDT NAO elegivel (holdout/arquetipos/casos-chave): pesos NAO salvos");
    process.exit(1);
  }
  const forest = gbdt.serialize(model);
  forest.temp = gbdtTemp;
  const dest = path.join(__dirname, "..", "weights-page.js");
  const header = `// Modelo de paginas: floresta GBDT (gradient boosting, arvores multi-saida) + temperatura.
// ARQUIVO GERADO por tools/train-page-gbdt.js. Portao: holdout >= 99.5%,
// arquétipos e casos-chave verdes. Inference em nn.js (DarlModel), JS puro.
// Saidas: [inverter, brilho, contraste, sepia, dim, tint]
//   invert:  brilho = 0.6+0.8*b | contraste = 0.6+0.8*c | sepia = 0.5*s | tint = 0.25*t
//   retoque: brilho = 0.7+0.3*dim | contraste = 0.9+0.25*c | sepia = 0.5*s | tint = 0.25*t
"use strict";

globalThis.DARL_PAGE_WEIGHTS = `;
  const body = JSON.stringify(forest);
  fs.writeFileSync(dest, header + body + ";\n");
  console.log(`floresta salva em ${dest} (${fs.statSync(dest).size} bytes)`);
} else {
  console.log(eligible
    ? "GBDT elegivel (holdout, arquetipos e casos-chave); rode com --write para gravar"
    : "GBDT NAO elegivel: pesos NAO gravados");
  process.exitCode = eligible ? 0 : 2;
}
