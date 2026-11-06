// Testes dos modelos da extensao (rede de paginas v2 e rede de imagens).
// Uso: node tools/test-nn.js
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const src =
  fs.readFileSync(path.join(root, "weights-page.js"), "utf8") + "\n" +
  fs.readFileSync(path.join(root, "weights-images.js"), "utf8") + "\n" +
  fs.readFileSync(path.join(root, "weights-region.js"), "utf8") + "\n" +
  fs.readFileSync(path.join(root, "nn.js"), "utf8");
(0, eval)(src); // escopo global, igual ao carregamento dos scripts na extensao

const { DarlNN, DARL_PAGE_WEIGHTS, DARL_IMAGE_WEIGHTS, DARL_REGION_WEIGHTS } = globalThis;

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
expect(d.invert === true && d.brightness < dLight.brightness - 0.02,
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

// app de mensagens hibrido (painel lateral escuro + chat claro)
const MSG = vec({ htmlBg: 0.9, meanBg: 0.62, h0: 0.22, h1: 0.08, h6: 0.13, h7: 0.37,
  fracWithBg: 0.5, fracDark: 0.32, fracLight: 0.42, textLum: 0.48, contrast: 0.66,
  satMean: 0.3, colorful: 0.3, imgFrac: 0.04, mono: 0.02, fontMean: 0.45,
  smallUi: 0.3, fixedFrac: 0.18, navN: 0.5, formN: 0.35, mediaN: 0.25, metaDark: 0 });
d = decidePage(MSG);
expect(d.invert === true, "MESSAGING -> inverter", `brilho=${d.brightness.toFixed(2)}`);
const msgTemp = DARL_PAGE_WEIGHTS.temp || 1;
const msgConf = DarlNN.calibrate(d.p[0], msgTemp);
expect(msgConf >= 0.75, "MESSAGING -> confianca alta na decisao (antes ~56%)",
  `conf=${msgConf.toFixed(2)}`);

// ------------------------------------------------- calibracao de temperatura
// A extensao e inference-only: nao ha mais treino no navegador (v2.0.0).
const temp = DARL_PAGE_WEIGHTS.temp || 1;
expect(typeof DARL_PAGE_WEIGHTS.temp === "number" && temp >= 0.1 && temp <= 3,
  "pesos da pagina trazem temperatura calibrada pelo holdout", `T=${temp}`);

expect(DarlNN.calibrate(0.5, temp) === 0.5, "calibracao: p=0.5 permanece 0.5 (monotonica no limiar)");
const sharpen = DarlNN.calibrate(0.9, 0.784);
expect(sharpen > 0.9 && sharpen <= 1, "calibracao com T<1 aguca a confianca", `0.9 -> ${sharpen.toFixed(3)}`);
const soften = DarlNN.calibrate(0.9, 2);
expect(soften < 0.9, "calibracao com T>1 amolece a confianca", `0.9 -> ${soften.toFixed(3)}`);
expect(DarlNN.calibrate(0.92, 1) === 0.92, "calibracao com T=1 e identidade");

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

// ------------------------------------------------- rede de regioes
// Entradas: [lum, sat, textLum, contrast, areaFrac, isFixed, hasBgImg, childMediaFrac]
const regionNet = DarlNN.makeNet(DARL_REGION_WEIGHTS.dims, DARL_REGION_WEIGHTS);
const regionKeep = (f) => DarlNN.forward(regionNet, f).p[0] > 0.5;

expect(regionKeep([0.10, 0.3, 0.85, 0.8, 0.12, 1, 0, 0.05]) === true,
  "regiao: header escuro fixo -> manter original");
expect(regionKeep([0.08, 0.2, 0.8, 0.75, 0.08, 0, 0, 0.03]) === true,
  "regiao: footer escuro -> manter original");
expect(regionKeep([0.25, 0.35, 0.9, 0.7, 0.45, 0, 1, 0.05]) === true,
  "regiao: hero escuro com imagem -> manter original");
expect(regionKeep([0.12, 0.25, 0.85, 0.8, 0.05, 0, 0, 0.02]) === true,
  "regiao: card de codigo escuro -> manter original");
expect(regionKeep([0.85, 0.1, 0.12, 0.85, 0.5, 0, 0, 0.05]) === false,
  "regiao: bloco claro de conteudo -> seguir inversao da pagina");
expect(regionKeep([0.4, 0.5, 0.5, 0.5, 0.2, 0, 0, 0.1]) === false,
  "regiao: cinza intermediario indeciso segue a pagina (conservador)");

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

// ------------------------------------------------- matrizes SVG (modo Filter+)
const mx = globalThis.DarlMatrix;
expect(Boolean(mx), "DarlMatrix disponivel");

// invertNHue e involutiva: aplicada duas vezes = identidade (usa-se como reverso)
const inv = mx.invertNHue();
const inv2 = mx.multiplyMatrices(inv, inv);
const nearEye = inv2.every((row, i) => row.every((v, j) => Math.abs(v - (i === j ? 1 : 0)) < 2e-3));
expect(nearEye, "invertNHue x invertNHue = identidade (reverso exato)");

// branco puro invertido nao vira #000 puro (anti-halation: cap de contraste 0.90)
const chain1 = mx.composeDarkMatrix({ sepia: 0, grayscale: 0.03, contrast: 0.9, brightness: 0.95 });
const dark = mx.applyColorMatrix([255, 255, 255], chain1);
expect(dark.every((v) => v >= 8 && v <= 40), "WCAG: branco invertido fica cinza-escuro, nao #000",
  `rgb(${dark.join(",")})`);
expect(mx.applyColorMatrix([255, 255, 255], chain1).every((v) => v < 50), "branco vira tema escuro");

// texto escuro sobe pra quase-branco levemente cinza (anti-halation no texto)
const textOut = mx.applyColorMatrix([26, 26, 26], chain1);
expect(textOut.every((v) => v > 200), "WCAG: texto claro apos inversao fica acima de 200",
  `rgb(${textOut.join(",")})`);

// reverso da midia restaura a cor original (contraste/brightness pequenos)
const chain2 = mx.composeDarkMatrix({ sepia: 0, grayscale: 0, contrast: 1, brightness: 1 });
const orig = [80, 140, 220];
const inverted = mx.applyColorMatrix(orig, chain2);
const restored = mx.applyColorMatrix(inverted, inv);
expect(restored.every((v, i) => Math.abs(v - orig[i]) <= 2), "midia: invert + reverso = original",
  `rgb(${orig.join(",")}) -> rgb(${restored.join(",")})`);

// fidelidade de matiz: um azul puro permanece azulado apos invertNHue
const blue = mx.applyColorMatrix([40, 80, 220], inv);
expect(blue[2] > blue[0] + 30 && blue[2] > blue[1], "matiz preservado: azul continua azul",
  `rgb(${blue.join(",")})`);

console.log(failures === 0 ? "\ntodos os testes passaram" : `\n${failures} falha(s)`);
process.exit(failures === 0 ? 0 : 1);
