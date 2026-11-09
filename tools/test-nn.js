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
  fs.readFileSync(path.join(root, "nn.js"), "utf8") + "\n" +
  fs.readFileSync(path.join(root, "darl-features.js"), "utf8") + "\n" +
  fs.readFileSync(path.join(root, "element.js"), "utf8");
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

// O modelo de paginas pode ser MLP ou floresta GBDT: o despachante abstrai.
const pageModel = DarlModel.makeModel(DARL_PAGE_WEIGHTS);
function decidePage(x) {
  const p = DarlModel.forward(pageModel, x).p;
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

// variante pesada do hibrido de mensagens (sidebar maior: ~40% de elementos escuros)
const PRADO = vec({ htmlBg: 0.9, meanBg: 0.55, h0: 0.28, h1: 0.1, h6: 0.12, h7: 0.32,
  fracWithBg: 0.55, fracDark: 0.4, fracLight: 0.35, textLum: 0.45, lowContrast: 0.12,
  contrast: 0.62, satMean: 0.28, satHigh: 0.2, colorful: 0.28, imgFrac: 0.05, mono: 0.02,
  fontMean: 0.45, smallUi: 0.3, fixedFrac: 0.15, navN: 0.5, formN: 0.35, mediaN: 0.2, metaDark: 0 });
d = decidePage(PRADO);
const pradoConf = DarlNN.calibrate(d.p[0], DARL_PAGE_WEIGHTS.temp || 1);
expect(d.invert === true && pradoConf >= 0.75,
  "PRADO -> hibrido de mensagens pesado inverte com confianca alta (antes ~67%)",
  `conf=${pradoConf.toFixed(2)}`);

// caso REAL do dataLog (chat.pradoapp.com, Rocket.Chat, 06/11/2026): casca
// escura + painel branco de conteudo. As features por elemento parecem "site
// escuro" (fracDark 0.97), mas a pagina e hibrida com centro claro. Antes do
// arquetipo CHAT_HYBRID a IA dizia retoque com 95% e o chat ficava branco.
const ROCKET = [
  0.202, 0.213, 0.002, 0.971, 0.008, 0.005, 0, 0.011, 0, 0.005,
  0.058, 0.972, 0.005, 0.598, 0.959, 0.398, 0.339, 0.263, 0.263, 0.011,
  0.005, 0, 0.5, 0, 0.074, 0.002, 0, 0, 0, 0, 0, 0,
];
d = decidePage(ROCKET);
const rocketConf = DarlNN.calibrate(d.p[0], DARL_PAGE_WEIGHTS.temp || 1);
expect(d.invert === true && rocketConf >= 0.75,
  "CHAT_HYBRID -> chat real com casca escura inverte com confianca alta (antes retoque 95%)",
  `conf=${rocketConf.toFixed(2)}`);

// tema escuro nativo bem desenhado (Telegram/Discord dark): retoque quase identidade
const TG = vec({ htmlBg: 0.05, meanBg: 0.09, h0: 0.5, h1: 0.3, fracWithBg: 0.5, fracDark: 0.75,
  textLum: 0.85, lowContrast: 0.04, contrast: 0.82, satMean: 0.3, satHigh: 0.25, colorful: 0.25,
  imgFrac: 0.06, mono: 0.02, fontMean: 0.45, smallUi: 0.32, fixedFrac: 0.12, navN: 0.5,
  formN: 0.35, mediaN: 0.2, metaDark: 1 });
d = decidePage(TG);
const tgProb = DarlNN.calibrate(d.p[0], DARL_PAGE_WEIGHTS.temp || 1);
expect(d.invert === false && tgProb <= 0.25,
  "TELEGRAM_DARK -> retoque sem inversao, certeza alta (antes ~47% na fronteira)",
  `p(inverter)=${tgProb.toFixed(2)}`);
expect(d.brightness >= 0.9, "TELEGRAM_DARK -> retoque suave (tema ja bem desenhado)",
  `brilho=${d.brightness.toFixed(2)}`);
// novos centros da v2.3.0 (treino denso, 14 arquétipos)
const SHOP = vec({ htmlBg: 0.96, meanBg: 0.88, h7: 0.68, fracWithBg: 0.45, fracLight: 0.72,
  textLum: 0.15, contrast: 0.8, satMean: 0.35, satHigh: 0.28, colorful: 0.38,
  imgFrac: 0.12, fontMean: 0.48, smallUi: 0.16, navN: 0.7, formN: 0.5 });
d = decidePage(SHOP);
expect(d.invert === true, "SHOP -> inverter", `brilho=${d.brightness.toFixed(2)}`);

const SEARCHV = vec({ htmlBg: 1.0, meanBg: 0.96, h7: 0.85, fracWithBg: 0.12, fracLight: 0.9,
  textLum: 0.1, contrast: 0.88, satMean: 0.08, fontMean: 0.6, formN: 0.4 });
d = decidePage(SEARCHV);
expect(d.invert === true && d.brightness < dLight.brightness - 0.02,
  "SEARCH_MIN -> inverter mais escuro que o claro comum",
  `brilho=${d.brightness.toFixed(2)} vs ${dLight.brightness.toFixed(2)}`);

const SOCIALF = vec({ htmlBg: 0.93, meanBg: 0.85, h7: 0.62, fracWithBg: 0.55, fracLight: 0.68,
  textLum: 0.14, contrast: 0.82, satMean: 0.28, colorful: 0.32, imgFrac: 0.08,
  smallUi: 0.28, fixedFrac: 0.12, navN: 0.7, formN: 0.35 });
d = decidePage(SOCIALF);
expect(d.invert === true, "SOCIAL_FEED -> inverter", `brilho=${d.brightness.toFixed(2)}`);

const LONGF = vec({ htmlBg: 1.0, meanBg: 0.94, h7: 0.78, fracWithBg: 0.22, fracLight: 0.85,
  textLum: 0.12, contrast: 0.84, satMean: 0.1, mono: 0.12, fontMean: 0.56,
  titleFrac: 0.07, articleN: 0.8, tableN: 0.35 });
d = decidePage(LONGF);
expect(d.invert === true && d.sepia > dLight.sepia,
  "LONGFORM -> inverter com sépia maior (conforto de leitura)",
  `sepia=${d.sepia.toFixed(3)} vs ${dLight.sepia.toFixed(3)}`);

const GALLERYV = vec({ htmlBg: 0.9, meanBg: 0.7, h6: 0.1, h7: 0.5, fracWithBg: 0.5,
  fracDark: 0.15, fracLight: 0.5, textLum: 0.2, contrast: 0.72, satMean: 0.3,
  imgFrac: 0.2, bgImgFrac: 0.35, mediaN: 0.8 });
d = decidePage(GALLERYV);
expect(d.invert === true && d.brightness > dLight.brightness,
  "GALLERY -> inverter mais claro (arte visível)",
  `brilho=${d.brightness.toFixed(2)} vs ${dLight.brightness.toFixed(2)}`);

const POLISH = vec({ htmlBg: 0.07, meanBg: 0.1, h0: 0.5, h1: 0.28, fracWithBg: 0.45,
  fracDark: 0.78, textLum: 0.87, lowContrast: 0.02, contrast: 0.85, satMean: 0.14,
  smallUi: 0.3, fixedFrac: 0.15, metaDark: 0.75 });
d = decidePage(POLISH);
expect(d.invert === false && d.brightness > decidePage(BLUE).brightness,
  "DARK_POLISHED -> retoche mais suave que dashboard escuro",
  `brilho=${d.brightness.toFixed(2)}`);

const OLED = vec({ htmlBg: 0.01, meanBg: 0.03, h0: 0.8, h1: 0.12, fracWithBg: 0.35,
  fracDark: 0.92, textLum: 0.9, lowContrast: 0.03, contrast: 0.9, satMean: 0.05, metaDark: 1 });
d = decidePage(OLED);
expect(d.invert === false && d.brightness > decidePage(POLISH).brightness,
  "OLED_BLACK -> quase intocado", `brilho=${d.brightness.toFixed(2)}`);


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
expect(imgDecide([0.45, 0.25, 0.12, 0.2, 0.5, 0.06]) === true,
  "imagem: icone semitransparente medio-escuro -> manter invertida");
expect(imgDecide([0.0, 0.62, 0.15, 0.75, 0.05, 0.5]) === false,
  "imagem: emoji colorido opaco -> restaurar");
expect(imgDecide([0.0, 0.8, 0.25, 0.2, 0.02, 0.7]) === false,
  "imagem: screenshot claro opaco -> restaurar");


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
expect(regionKeep([0.06, 0.15, 0.85, 0.8, 0.28, 1, 0, 0.02]) === true,
  "regiao: sidebar escura fixa de mensagens -> manter original");
expect(regionKeep([0.05, 0.2, 0.7, 0.6, 0.3, 0, 0, 0.85]) === true,
  "regiao: area de video escura -> manter original");


// ------------------------------------------------- motor por elemento (v4)
// As funcoes de remapeamento de cor do element.js sao puras: testadas sem DOM.
const DE = globalThis.DarlElement;
const lumCss = (css) => { const c = DarlFeatures.parseRGB(css); return DarlFeatures.lum(c.r, c.g, c.b); };

const mb = DE.mapBackground({ r: 255, g: 255, b: 255, a: 1 });
expect(lumCss(mb.css) < 0.2 && lumCss(mb.css) > 0.02,
  "elemento: fundo branco -> escuro (nunca preto puro)", mb.css);

const mbBlue = DE.mapBackground({ r: 173, g: 216, b: 230, a: 1 });
const cb = DarlFeatures.parseRGB(mbBlue.css);
expect(cb.b > cb.r, "elemento: fundo azul claro continua azul no escuro", mbBlue.css);

const mt = DE.mapText({ r: 10, g: 10, b: 10, a: 1 }, 0.12);
const ct = DarlFeatures.parseRGB(mt.css);
const ratioT = DarlFeatures.contrastRatio(DarlFeatures.lum(ct.r, ct.g, ct.b), 0.12);
expect(ratioT >= 4.5, "elemento: texto escuro vira claro com contraste WCAG AA",
  `${mt.css} ratio=${ratioT.toFixed(1)}`);

const mtLink = DE.mapText({ r: 0, g: 0, b: 238, a: 1 }, 0.12);
const cl = DarlFeatures.parseRGB(mtLink.css);
expect(cl.b > cl.r && cl.b > 100, "elemento: link azul continua azul e legivel", mtLink.css);

const grad = "linear-gradient(rgb(255, 255, 255), rgb(230, 230, 230))";
const g = DE.remapGradient(grad);
expect(g && g !== grad && lumCss(g.match(/rgba?\([^)]*\)/g)[0]) < 0.2,
  "elemento: gradiente claro -> gradiente escuro", g);

const sh = DE.remapShadow("rgba(255, 255, 255, 0.5) 0px 1px 2px", 0.12);
expect(sh && !/255,\s*255,\s*255/.test(sh), "elemento: sombra branca vira sombra escura", sh);

const shDark = DE.remapShadow("rgba(0, 0, 0, 0.2) 0px 2px 4px", 0.12);
expect(shDark === null, "elemento: sombra ja escura fica como esta", String(shDark));

const mbA = DE.mapBackground({ r: 255, g: 255, b: 255, a: 0.4 });
expect(DarlFeatures.parseRGB(mbA.css) && Math.abs(DarlFeatures.parseRGB(mbA.css).a - 0.4) < 0.05,
  "elemento: fundo translucido preserva o alpha", mbA.css);

expect(DE.parseColorList("rgb(1, 2, 3) rgba(4, 5, 6, 0.5)").length === 2,
  "elemento: parser de listas de cores");

// ------------------------------------------- guarda de interacao (v4.2)
// Regras :hover/:focus nao existem no estilo computado em repouso: a guarda
// le o estado naquele instante e congela o remapeamento no elemento.
const gh = DE.guardDecls({ r: 225, g: 228, b: 233, a: 1 }, "none", { r: 47, g: 52, b: 65, a: 1 });
expect(gh.length === 2,
  "guarda: hover claro gera fundo escuro + texto claro", gh.join(" | "));
const ghBg = DarlFeatures.parseRGB(gh[0]);
const ghFg = DarlFeatures.parseRGB(gh[1]);
expect(DarlFeatures.lum(ghBg.r, ghBg.g, ghBg.b) < 0.25 && DarlFeatures.lum(ghFg.r, ghFg.g, ghFg.b) > 0.7,
  "guarda: regras do hover ficam legiveis (fundo escuro, texto claro)");

const ghKeep = DE.guardDecls({ r: 47, g: 52, b: 65, a: 1 }, "none", { r: 216, g: 222, b: 230, a: 1 });
expect(ghKeep.length === 0, "guarda: hover ja escuro nao gera regra", String(ghKeep.length));

const ghGrad = DE.guardDecls(null, "linear-gradient(rgb(255, 255, 255), rgb(240, 240, 240))", null);
expect(ghGrad.length === 1 && ghGrad[0].startsWith("background-image:"),
  "guarda: gradiente de hover claro vira escuro", ghGrad[0].slice(0, 60));

// ---------------------------------------------- acentos vivos (v4.3.2)
// A bolinha de presenca e um dot minusculo e saturado: a cor viva E o sinal
// visual. O remapeamento normal a apagaria (verde claro = "fundo claro").
expect(DE.isAccentColor({ r: 45, g: 228, b: 165, a: 1 }) === true,
  "acento: verde de presenca vivo e acento", "rgb(45,228,165)");
expect(DE.isAccentColor({ r: 238, g: 238, b: 238, a: 1 }) === false,
  "acento: cinza claro NAO e acento (e so um fundo pequeno)");
expect(DE.isAccentColor({ r: 26, g: 35, b: 126, a: 1 }) === false,
  "acento: azul escuro abaixo do limiar de clareza nao e acento");
expect(DE.isAccentColor({ r: 255, g: 235, b: 59, a: 0.02 }) === false,
  "acento: quase transparente nao e acento");
expect(DE.isAccentSize(10, 10) === true && DE.isAccentSize(28, 28) === false &&
  DE.isAccentSize(0, 0) === false,
  "acento: so elementos minusculos (ate 14px) contam como dot/badge");

// sem a regra, o verde seria escurecido (o bug da bolinha apagada):
const greenDim = DE.mapBackground({ r: 45, g: 228, b: 165, a: 1 });
expect(lumCss(greenDim.css) < 0.2,
  "acento: sem preservacao o verde viraria apagado (documenta o bug)", greenDim.css);

// guarda de interacao respeita o acento: hover na bolinha nao a escurece
const ghAccent = DE.guardDecls({ r: 45, g: 228, b: 165, a: 1 }, "none", null, true);
expect(ghAccent.length === 0, "guarda: acento vivo com keepBg mantem a cor original");
const ghAccentNoKeep = DE.guardDecls({ r: 45, g: 228, b: 165, a: 1 }, "none", null, false);
expect(ghAccentNoKeep.length === 1 && ghAccentNoKeep[0].startsWith("background-color:"),
  "guarda: sem keepBg o acento seria remapeado", String(ghAccentNoKeep.length));

// teto do motor (v4.3.2): a visao de conversa do Rocket.Chat passa de 8000
// elementos e ficava METADE remapeada (o pior estado). 30000 cobre chats reais.
expect(DE.MAX_ELEMENTS === 30000,
  "motor: teto de elementos cobre chats SPA grandes", String(DE.MAX_ELEMENTS));

// ------------------------------------------- varredura sem travar (v4.3.3)
// SPAs gigantes (Rocket.Chat) mutam sem parar: a fila da varredura e
// alimentada pelo observer, nunca por reconsulta da pagina inteira.
expect(DE.isQueueableNode({ nodeType: 1, tagName: "DIV", id: "" }) === true,
  "fila: elemento comum entra na varredura");
expect(DE.isQueueableNode({ nodeType: 1, tagName: "SCRIPT", id: "" }) === false,
  "fila: script/style/meta fora da varredura");
expect(DE.isQueueableNode({ nodeType: 3, tagName: undefined, id: "" }) === false,
  "fila: no de texto fora da varredura");
expect(DE.isQueueableNode({ nodeType: 1, tagName: "DIV", id: "darl-element-style" }) === false &&
  DE.isQueueableNode({ nodeType: 1, tagName: "DIV", id: "darl-dark-style" }) === false,
  "fila: estilos da propria extensao fora da varredura");
// contrato anti-travamento: flush de regras com intervalo minimo (cada flush
// custa um recalculo de estilo da pagina inteira) e guarda com recheck
// espaçado (mousemove dispara dezenas de eventos por segundo).
expect(DE.FLUSH_MS >= 400, "motor: flush de regras espaçado (anti-travamento)",
  String(DE.FLUSH_MS));
expect(DE.GUARD_RECHECK_MS >= 1000, "guarda: recheck por elemento espaçado (anti-travamento)",
  String(DE.GUARD_RECHECK_MS));

// ----------------------------------- rotulagem de dados reais (v4.3)
// O crawler coleta paginas reais; o rotulo vem da aparencia original
// (auto-labeling perceptual). Sem confianca, o registro fica de fora.
const LR = require("./load-real-data.js");
expect(LR.labelEntry({ antes: { meanLum: 0.9, darkFrac: 0.05, lumStd: 0.08 }, features: new Array(32).fill(0.1) }).label === "light",
  "dados reais: pagina clara rotulada inverter");
expect(LR.labelEntry({ antes: { meanLum: 0.12, darkFrac: 0.85, lumStd: 0.05 }, features: new Array(32).fill(0.1) }).label === "dark",
  "dados reais: pagina escura rotulada retoque");
expect(LR.labelEntry({ antes: { meanLum: 1.0, darkFrac: 0, lumStd: 0.005 }, features: new Array(32).fill(0) }) === null,
  "dados reais: pagina em branco/erro descartada");
expect(LR.labelEntry({ antes: { meanLum: 0.5, darkFrac: 0.4, lumStd: 0.06 }, features: new Array(32).fill(0.1) }) === null,
  "dados reais: hibrido ambiguo descartado (sem rotulo confiavel)");
// hibrido de APARENCIA (screenshot cinza) desambiguado pelo CONTEUDO (v4.3.1):
// paginas claras cheias de midias (hero colorido arrasta o meanLum, o elemento
// nao mente) e paginas escuras com aparencia cinza.
const hLight = new Array(32).fill(0.2); hLight[12] = 0.97; hLight[13] = 0.25;
expect(LR.labelEntry({ antes: { meanLum: 0.42, darkFrac: 0.29, lumStd: 0.3 }, features: hLight }).label === "light",
  "dados reais: hibrido de aparencia com conteudo claro rotulado inverter (ex. vimeo/threads)");
const hDark = new Array(32).fill(0.2); hDark[11] = 0.96; hDark[13] = 0.9;
expect(LR.labelEntry({ antes: { meanLum: 0.43, darkFrac: 0.39, lumStd: 0.31 }, features: hDark }).label === "dark",
  "dados reais: hibrido de aparencia com conteudo escuro rotulado retoque (ex. roblox/steam)");
const hAmb = new Array(32).fill(0.2); hAmb[12] = 0.97; hAmb[13] = 0.56;
expect(LR.labelEntry({ antes: { meanLum: 0.57, darkFrac: 0.4, lumStd: 0.44 }, features: hAmb }) === null,
  "dados reais: hibrido com texto na zona cinza continua descartado");

// ------------------------------------------------- infra
const dimsRef = [32, 32, 24, 6];
const refNet = DarlNN.makeNet(dimsRef);
const ser = DarlNN.serialize(refNet);
expect(DarlNN.compatible(ser, dimsRef), "serializacao compativel com o modelo");
expect(!DarlNN.compatible({ dims: [11, 16, 12, 4] }, dimsRef),
  "pesos da v1 (11 features) rejeitados pela guarda de compatibilidade");
const again = DarlNN.makeNet(ser.dims, ser);
const p1 = DarlNN.forward(again, LIGHT).p;
const p2 = DarlNN.forward(refNet, LIGHT).p;
expect(p1.every((v, i) => near(v, p2[i], 1e-4)), "serializacao round-trip",
  `json=${JSON.stringify(ser).length} bytes`);

// despachante de modelo: a floresta GBDT do weights-page.js carrega pelo
// DarlModel e sobrevive a um round-trip JSON identica
expect(DARL_PAGE_WEIGHTS.kind === "gbdt", "modelo de paginas atual e floresta GBDT");
const pageModel2 = DarlModel.makeModel(JSON.parse(JSON.stringify(DARL_PAGE_WEIGHTS)));
const pg1 = DarlModel.forward(pageModel2, LIGHT).p;
const pg2 = DarlModel.forward(pageModel, LIGHT).p;
expect(pg1.every((v, i) => near(v, pg2[i], 1e-6)), "floresta round-trip via JSON",
  `${DARL_PAGE_WEIGHTS.trees.length} arvores`);

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

// ------------------------------------------- frames sem content script (v4.3.4)
// O MV3 injeta o content script em frames http(s) (all_frames), mas NAO em
// about:blank/srcdoc: o documento topo tem de remapea-los pelo contentDocument.
expect(DarlElement.isUnscriptedFrameURL("about:blank"),
  "frame: about:blank e remapeavel pelo topo");
expect(DarlElement.isUnscriptedFrameURL("about:srcdoc"),
  "frame: about:srcdoc e remapeavel pelo topo");
expect(!DarlElement.isUnscriptedFrameURL("https://chat.pradoapp.com/direct/joao"),
  "frame: http(s) tem content script proprio (all_frames), topo nao mexe");
expect(!DarlElement.isUnscriptedFrameURL(""),
  "frame: URL vazia nao e alvo do motor de frames");
expect(!DarlElement.isUnscriptedFrameURL(null),
  "frame: tipo invalido nao derruba o motor");

// isUnscriptedFrameAttrs: deteccao DECLARATIVA de frame sem content script.
// O doc.URL de about:blank HERDA a URL do pai no Chrome — conferir URL nao
// identifica o frame (bug do CI v4.3.4). Os atributos sao o sinal confiavel.
expect(DarlElement.isUnscriptedFrameAttrs(null, false),
  "frame: sem src (about:blank sincrono de editores/preview) e remapeavel");
expect(DarlElement.isUnscriptedFrameAttrs("", false),
  "frame: src vazio e about:blank");
expect(DarlElement.isUnscriptedFrameAttrs("about:blank", false),
  "frame: src about:blank declarado");
expect(DarlElement.isUnscriptedFrameAttrs("  ABOUT:BLANK  ", false),
  "frame: deteccao tolera maiuscula e espaco");
expect(DarlElement.isUnscriptedFrameAttrs("about:srcdoc", false),
  "frame: src about:srcdoc declarado");
expect(DarlElement.isUnscriptedFrameAttrs("https://x.com/f.html", true),
  "frame: srcdoc vence mesmo com src http junto");
expect(DarlElement.isUnscriptedFrameAttrs("javascript:'<b>oi</b>'", false),
  "frame: javascript: nao recebe content script");
expect(DarlElement.isUnscriptedFrameAttrs("data:text/html,<b>oi</b>", false),
  "frame: data: nao recebe content script");
expect(DarlElement.isUnscriptedFrameAttrs("blob:https://x.com/123", false),
  "frame: blob: nao recebe content script");
expect(!DarlElement.isUnscriptedFrameAttrs("https://chat.pradoapp.com/direct/joao", false),
  "frame: src http tem content script proprio (all_frames)");
expect(!DarlElement.isUnscriptedFrameAttrs("//cdn.exemplo.com/frame.html", false),
  "frame: src relativo-protocolo navega http(s) e tem script proprio");
expect(!DarlElement.isUnscriptedFrameAttrs("/frame.html", false),
  "frame: src relativo navega http(s) e tem script proprio");

console.log(failures === 0 ? "\ntodos os testes passaram" : `\n${failures} falha(s)`);
process.exit(failures === 0 ? 0 : 1);
