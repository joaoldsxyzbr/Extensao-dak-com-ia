// Testes dos modelos da extensao (rede de paginas v2 e rede de imagens).
// Uso: node tools/test-nn.js
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const src =
  fs.readFileSync(path.join(root, "weights-page.js"), "utf8") + "\n" +
  fs.readFileSync(path.join(root, "weights-images.js"), "utf8") + "\n" +
  fs.readFileSync(path.join(root, "nn.js"), "utf8");
(0, eval)(src); // escopo global, igual ao carregamento dos scripts na extensao

const { DarlNN, DARL_PAGE_WEIGHTS, DARL_IMAGE_WEIGHTS } = globalThis;

let failures = 0;
function expect(cond, name, detail) {
  const ok = Boolean(cond);
  console.log(`${ok ? "ok " : "FAIL"} - ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// ordem canonica das 32 features (identica a tools/train-page-model.js)
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

const pageNet = DarlNN.makeNet(DARL_PAGE_WEIGHTS.dims, DARL_PAGE_WEIGHTS);
function decidePage(x) {
  const p = DarlNN.forward(pageNet, x).p;
  return {
    p,
    invert: p[0] > 0.5,
    brightness: p[0] > 0.5 ? 0.6 + 0.8 * p[1] : 0.7 + 0.3 * p[4],
    contrast: p[0] > 0.5 ? 0.6 + 0.8 * p[2] : 0.9 + 0.25 * p[2],
    sepia: 0.5 * p[3],
    tint: 0.25 * p[5],
  };
}

// ------------------------------------------------- arquétipos de pagina
const LIGHT = vec({ htmlBg: 0.95, meanBg: 0.9, h7: 0.75, fracWithBg: 0.35, fracLight: 0.78,
  textLum: 0.13, contrast: 0.85, satMean: 0.12, fontMean: 0.55, smallUi: 0.2 });
const HARSH = vec({ htmlBg: 1.0, meanBg: 0.97, h7: 0.85, fracLight: 0.93, textLum: 0.05,
  contrast: 0.92, satMean: 0.05, mono: 0.5, fontMean: 0.5, smallUi: 0.25, navN: 0.6 });
const CREAM = vec({ htmlBg: 0.9, meanBg: 0.88, h7: 0.6, fracWithBg: 0.4, fracLight: 0.7,
  textLum: 0.25, contrast: 0.75, satMean: 0.35, satHigh: 0.3, colorful: 0.5,
  fontMean: 0.55, titleFrac: 0.12, articleN: 0.7 });
const DARK = vec({ htmlBg: 0.07, meanBg: 0.11, h0: 0.55, h1: 0.25, fracWithBg: 0.5,
  fracDark: 0.82, textLum: 0.8, contrast: 0.78, satMean: 0.28, fontMean: 0.55,
  smallUi: 0.3, mediaN: 0.5, metaDark: 1 });
const BLUE = vec({ htmlBg: 0.1, meanBg: 0.15, h0: 0.5, h1: 0.3, fracWithBg: 0.6,
  fracDark: 0.75, textLum: 0.85, contrast: 0.8, satMean: 0.6, satHigh: 0.7,
  colorful: 0.7, smallUi: 0.32, fixedFrac: 0.18, navN: 0.8, tableN: 0.55, formN: 0.55 });
const MIXED = vec({ htmlBg: 0.55, meanBg: 0.55, h0: 0.2, h1: 0.15, h6: 0.15, h7: 0.3,
  fracWithBg: 0.45, fracDark: 0.35, fracLight: 0.35, textLum: 0.3, contrast: 0.6,
  satMean: 0.25, colorful: 0.35, titleFrac: 0.15 });

let d = decidePage(LIGHT);
expect(d.invert === true, "LIGHT_WEB -> inverter", `brilho=${d.brightness.toFixed(2)}`);
const dLight = d;
d = decidePage(HARSH);
expect(d.invert === true && d.brightness < dLight.brightness - 0.03,
  "HARSH_WHITE -> inverter mais escuro que o claro comum",
  `brilho=${d.brightness.toFixed(2)} vs ${dLight.brightness.toFixed(2)}`);
d = decidePage(CREAM);
expect(d.invert === true && d.tint > dLight.tint,
  "CREAM -> inverter com tint neutro maior", `tint=${d.tint.toFixed(3)}`);
d = decidePage(DARK);
expect(d.invert === false, "DARK -> retoque escuro, sem inversao", `dim=${d.brightness.toFixed(2)}`);
d = decidePage(BLUE);
expect(d.invert === false && d.brightness > decidePage(DARK).brightness,
  "BLUE_DASH -> retoque mais suave que DARK", `dim=${d.brightness.toFixed(2)}`);
d = decidePage(MIXED);
expect(d.invert === true, "MIXED -> inverter");

// ------------------------------------------------- feedback (treino no navegador)
function feedbackOnce(features, appliedInvert, direction) {
  const m = DarlNN.makeNet(DARL_PAGE_WEIGHTS.dims, DARL_PAGE_WEIGHTS);
  const p = DarlNN.forward(m, features).p;
  const target = p.slice();
  if (appliedInvert) {
    const moved = (0.6 + 0.8 * p[1]) + (direction === "darker" ? -0.15 : 0.15);
    target[1] = clamp01((moved - 0.6) / 0.8);
  } else {
    const moved = (0.7 + 0.3 * p[4]) + (direction === "darker" ? -0.05 : 0.05);
    target[4] = clamp01((moved - 0.7) / 0.3);
  }
  for (let i = 0; i < 30; i++) DarlNN.train(m, features, target, 0.1);
  return DarlNN.forward(m, features).p;
}

const before = decidePage(LIGHT).brightness;
const afterP = feedbackOnce(LIGHT, true, "darker");
const after = 0.6 + 0.8 * afterP[1];
expect(after < before - 0.06, "feedback 'claro demais' reduz brilho previsto (ramo invert)",
  `${before.toFixed(3)} -> ${after.toFixed(3)}`);
expect(afterP[1] > 0, "feedback mantem brilho dentro do mapeamento", `p1=${afterP[1].toFixed(3)}`);

const beforeDim = decidePage(DARK).brightness;
const afterDimP = feedbackOnce(DARK, false, "lighter");
const afterDim = 0.7 + 0.3 * afterDimP[4];
expect(afterDim > beforeDim + 0.03, "feedback 'escuro demais' aumenta dim do retoque",
  `${beforeDim.toFixed(3)} -> ${afterDim.toFixed(3)}`);

// decisao preservada apos treino nos dois ramos
const trained = (function () {
  const m1 = DarlNN.makeNet(DARL_PAGE_WEIGHTS.dims, DARL_PAGE_WEIGHTS);
  const t = DarlNN.forward(m1, LIGHT).p;
  for (let i = 0; i < 30; i++) DarlNN.train(m1, LIGHT, [t[0], clamp01(t[1] - 0.19), t[2], t[3], t[4], t[5]], 0.1);
  return m1;
})();
expect(DarlNN.forward(trained, LIGHT).p[0] > 0.5 && DarlNN.forward(trained, DARK).p[0] < 0.5,
  "apos feedback, decisao inverter preservada (clara=sim, escura=nao)");

// ------------------------------------------------- rede de imagens
const imgNet = DarlNN.makeNet(DARL_IMAGE_WEIGHTS.dims, DARL_IMAGE_WEIGHTS);
const imgDecide = (f) => DarlNN.forward(imgNet, f).p[0] > 0.5;

expect(imgDecide([0.6, 0.15, 0.15, 0.15, 0.78, 0.03]) === true,
  "imagem: icone escuro transparente -> manter invertida (fica claro)");
expect(imgDecide([0.6, 0.85, 0.12, 0.12, 0.03, 0.78]) === false,
  "imagem: icone claro transparente -> restaurar");
expect(imgDecide([0.0, 0.5, 0.22, 0.42, 0.25, 0.25]) === false,
  "imagem: foto media -> restaurar");
expect(imgDecide([0.0, 0.21, 0.09, 0.32, 0.89, 0.0]) === false,
  "imagem: foto muito escura opaca -> restaurar (regressao v1)");
expect(imgDecide([0.45, 0.55, 0.18, 0.6, 0.2, 0.2]) === false,
  "imagem: logo colorido transparente -> restaurar");
expect(imgDecide([0.3, 0.2, 0.1, 0.2, 0.6, 0.05]) === true,
  "imagem: icone escuro com pouca transparencia -> manter invertida");

// ------------------------------------------------- infra
const ser = DarlNN.serialize(pageNet);
expect(DarlNN.compatible(ser, DARL_PAGE_WEIGHTS.dims), "serializacao compativel com o modelo");
expect(!DarlNN.compatible({ dims: [11, 16, 12, 4] }, DARL_PAGE_WEIGHTS.dims),
  "pesos da v1 (11 features) rejeitados pela guarda de compatibilidade");
const again = DarlNN.makeNet(ser.dims, ser);
const p1 = DarlNN.forward(again, LIGHT).p;
const p2 = DarlNN.forward(pageNet, LIGHT).p;
expect(p1.every((v, i) => near(v, p2[i], 1e-4)), "serializacao round-trip",
  `json=${JSON.stringify(ser).length} bytes`);
expect(JSON.stringify(ser).length < 40000, "pesos compactos para o storage");

const tiny = DarlNN.makeNet([3, 4, 1]);
const xs = [[0.1, 0.2, 0.3], [0.8, 0.1, 0.5], [0.5, 0.9, 0.2], [0.3, 0.3, 0.9]];
const ys = [[1], [0], [0], [1]];
let loss0 = 0, loss1 = 0;
for (let i = 0; i < xs.length; i++) loss0 += DarlNN.train(tiny, xs[i], ys[i], 0.5);
for (let e = 0; e < 200; e++) for (let i = 0; i < xs.length; i++) DarlNN.train(tiny, xs[i], ys[i], 0.5);
for (let i = 0; i < xs.length; i++) loss1 += DarlNN.train(tiny, xs[i], ys[i], 0.5);
expect(loss1 < loss0 * 0.05, "rede generica aprende (makeNet + train)",
  `loss ${(loss0 / xs.length).toFixed(4)} -> ${(loss1 / xs.length).toFixed(4)}`);

console.log(failures === 0 ? "\ntodos os testes passaram" : `\n${failures} falha(s)`);
process.exit(failures === 0 ? 0 : 1);
