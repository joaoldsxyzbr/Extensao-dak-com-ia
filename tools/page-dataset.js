// Dataset de treino do modelo de paginas (compartilhado).
// Fonte unica dos 15 arquetipos + geracao de amostras (treino/holdout) para
// TODOS os treinadores da rede de paginas: MLP (train-page-model.js) e
// GBDT (train-page-gbdt.js). A ordem das features e canonica aqui, em
// darl-features.js e em tools/test-nn.js.
"use strict";

const lab = require("./nnlab.js");

const IN = 32, OUT = 6;
const DIMS = [IN, 32, 24, OUT];

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
  { name: "LIGHT_WEB", w: 0.13, family: "LIGHT", // site claro comum (portais, blogs)
    f: { htmlBg:0.95, meanBg:0.9, h6:0.05, h7:0.75, fracWithBg:0.35, fracDark:0.06, fracLight:0.78,
      textLum:0.13, lowContrast:0.05, contrast:0.85, satMean:0.12, satHigh:0.08, colorful:0.12,
      imgFrac:0.05, bgImgFrac:0.08, mono:0.08, fontMean:0.55, titleFrac:0.05, smallUi:0.2, fixedFrac:0.08,
      articleN:0.4, navN:0.6, tableN:0.15, formN:0.3, mediaN:0.2, metaDark:0.02 },
    vary: { htmlBg:0.04, meanBg:0.05, h7:0.15, fracWithBg:0.1, fracDark:0.1, fracLight:0.06,
      textLum:0.05, contrast:0.05, satMean:0.05, satHigh:0.06, colorful:0.07, mono:0.1,
      fontMean:0.1, titleFrac:0.04, smallUi:0.1 },
    y: [1, 0.44, 0.44, 0.08, 0.5, 0.02] },
  { name: "HARSH_WHITE", w: 0.07, family: "LIGHT", // pagina branca dura (docs, login)
    f: { htmlBg:1.0, meanBg:0.97, h7:0.85, fracWithBg:0.3, fracDark:0.01, fracLight:0.93,
      textLum:0.05, lowContrast:0.02, contrast:0.92, satMean:0.05, satHigh:0.02, colorful:0.05,
      imgFrac:0.03, bgImgFrac:0.25, mono:0.5, fontMean:0.5, titleFrac:0.02, smallUi:0.25, fixedFrac:0.02,
      articleN:0.3, navN:0.6, tableN:0.25, formN:0.2, mediaN:0.02, metaDark:0.02 },
    vary: { h7:0.1, fracWithBg:0.08, textLum:0.03, contrast:0.04, mono:0.15, smallUi:0.08, formN:0.15 },
    y: [1, 0.27, 0.4, 0.12, 0.5, 0.2] },
  { name: "CREAM", w: 0.05, family: "LIGHT", // noticias/leitores creme
    f: { htmlBg:0.9, meanBg:0.88, h6:0.05, h7:0.6, fracWithBg:0.4, fracDark:0.05, fracLight:0.7,
      textLum:0.25, lowContrast:0.12, contrast:0.75, satMean:0.35, satHigh:0.3, colorful:0.5,
      imgFrac:0.04, bgImgFrac:0.06, mono:0.06, fontMean:0.55, titleFrac:0.12, smallUi:0.15, fixedFrac:0.05,
      articleN:0.7, navN:0.5, tableN:0.1, formN:0.15, mediaN:0.1, metaDark:0.05 },
    vary: { htmlBg:0.04, h7:0.12, fracLight:0.08, textLum:0.08, lowContrast:0.05,
      satMean:0.08, satHigh:0.1, colorful:0.1, titleFrac:0.05 },
    y: [1, 0.44, 0.4, 0.04, 0.5, 0.3] },
  { name: "MIXED", w: 0.06, family: "LIGHT", // header escuro + corpo claro
    f: { htmlBg:0.55, meanBg:0.55, h0:0.2, h1:0.15, h2:0.1, h3:0.08, h4:0.08, h6:0.15, h7:0.3,
      fracWithBg:0.45, fracDark:0.35, fracLight:0.35,
      textLum:0.3, lowContrast:0.15, contrast:0.6, satMean:0.25, satHigh:0.25, colorful:0.35,
      imgFrac:0.06, bgImgFrac:0.1, mono:0.1, fontMean:0.55, titleFrac:0.15, smallUi:0.22, fixedFrac:0.15,
      articleN:0.45, navN:0.65, tableN:0.3, formN:0.4, mediaN:0.35, metaDark:0.25 },
    vary: { htmlBg:0.12, meanBg:0.1, fracDark:0.1, fracLight:0.1, lowContrast:0.06,
      colorful:0.08, titleFrac:0.08, metaDark:0.2 },
    y: [1, 0.4, 0.375, 0.1, 0.5, 0.05] },
  { name: "MESSAGING", w: 0.07, family: "LIGHT", // app de mensagens hibrido: painel lateral escuro + chat claro
    f: { htmlBg:0.9, meanBg:0.62, h0:0.22, h1:0.08, h2:0.05, h3:0.04, h4:0.05, h5:0.06, h6:0.13, h7:0.37,
      fracWithBg:0.5, fracDark:0.32, fracLight:0.42,
      textLum:0.48, lowContrast:0.1, contrast:0.66,
      satMean:0.3, satHigh:0.18, colorful:0.3,
      imgFrac:0.04, bgImgFrac:0.03, mono:0.02,
      fontMean:0.45, titleFrac:0.04, smallUi:0.3, fixedFrac:0.18,
      articleN:0.05, navN:0.5, tableN:0.02, formN:0.35, mediaN:0.25, metaDark:0.05 },
    vary: { htmlBg:0.04, h0:0.08, h7:0.1, fracDark:0.08, fracLight:0.08, textLum:0.08,
      satMean:0.06, colorful:0.06, smallUi:0.08, fixedFrac:0.06, navN:0.15, formN:0.1 },
    y: [1, 0.42, 0.30, 0.05, 0.5, 0.08] },
  { name: "CHAT_HYBRID", w: 0.06, family: "LIGHT", // chat real (Rocket.Chat): casca escura + painel branco sobreposto
    // Centro calibrado no vetor REAL exportado de chat.pradoapp.com (dataLog,
    // 06/11/2026): html bg escuro, quase todos os elementos transparentes
    // (fracWithBg ~0.06) e o painel branco do conteudo e uma minoria do DOM.
    // A pagina parece "escura" para features por elemento, mas visualmente e
    // hibrido com centro claro; texto medio claro da sidebar acha contraste
    // baixo contra o fundo herdado. Assinatura: fracDark ~0.97 + lowContrast
    // ~0.96 + textLum ~0.6 (num site escuro de verdade o texto e claro e o
    // contraste medido e bom).
    f: { htmlBg:0.2, meanBg:0.21, h1:0.97, fracWithBg:0.06, fracDark:0.97, fracLight:0.01,
      textLum:0.6, lowContrast:0.96, contrast:0.4,
      satMean:0.34, satHigh:0.26, colorful:0.26,
      imgFrac:0.01, bgImgFrac:0.005, mono:0,
      fontMean:0.5, titleFrac:0, smallUi:0.07, fixedFrac:0.002,
      articleN:0, navN:0, tableN:0, formN:0, mediaN:0, metaDark:0 },
    vary: { htmlBg:0.06, h1:0.06, fracWithBg:0.04, fracDark:0.04, fracLight:0.02,
      textLum:0.08, lowContrast:0.06, contrast:0.08,
      satMean:0.08, satHigh:0.08, colorful:0.08, imgFrac:0.02, smallUi:0.05,
      fixedFrac:0.03, navN:0.15, formN:0.15, mediaN:0.15 },
    y: [1, 0.42, 0.30, 0.05, 0.5, 0.08] },
  { name: "SHOP", w: 0.06, family: "LIGHT", // e-commerce: fundo branco, cards e botoes saturados
    f: { htmlBg:0.96, meanBg:0.88, h6:0.06, h7:0.68, fracWithBg:0.45, fracDark:0.05, fracLight:0.72,
      textLum:0.15, lowContrast:0.08, contrast:0.8, satMean:0.35, satHigh:0.28, colorful:0.38,
      imgFrac:0.12, bgImgFrac:0.12, mono:0.03, fontMean:0.48, titleFrac:0.06, smallUi:0.16, fixedFrac:0.06,
      articleN:0.2, navN:0.7, tableN:0.1, formN:0.5, mediaN:0.2, metaDark:0.02 },
    vary: { h7:0.1, fracWithBg:0.08, imgFrac:0.05, satMean:0.08, satHigh:0.08, colorful:0.08, formN:0.15 },
    y: [1, 0.42, 0.42, 0.06, 0.5, 0.14] },
  { name: "SEARCH_MIN", w: 0.03, family: "LIGHT", // buscador/portada minimalista quase vazia
    f: { htmlBg:1.0, meanBg:0.96, h7:0.85, fracWithBg:0.12, fracDark:0.01, fracLight:0.9,
      textLum:0.1, lowContrast:0.03, contrast:0.88, satMean:0.08, satHigh:0.04, colorful:0.06,
      imgFrac:0.02, bgImgFrac:0.02, mono:0.06, fontMean:0.6, titleFrac:0.03, smallUi:0.2, fixedFrac:0.05,
      articleN:0.1, navN:0.3, tableN:0.05, formN:0.4, mediaN:0.02, metaDark:0.02 },
    vary: { h7:0.06, fracWithBg:0.05, contrast:0.04, formN:0.1 },
    y: [1, 0.22, 0.45, 0.08, 0.5, 0.04] },
  { name: "SOCIAL_FEED", w: 0.06, family: "LIGHT", // feed social: cards brancos, acoes coloridas, UI pequena
    f: { htmlBg:0.93, meanBg:0.85, h6:0.08, h7:0.62, fracWithBg:0.55, fracDark:0.06, fracLight:0.68,
      textLum:0.14, lowContrast:0.07, contrast:0.82, satMean:0.28, satHigh:0.2, colorful:0.32,
      imgFrac:0.08, bgImgFrac:0.1, mono:0.03, fontMean:0.5, titleFrac:0.04, smallUi:0.28, fixedFrac:0.12,
      articleN:0.15, navN:0.7, tableN:0.05, formN:0.35, mediaN:0.25, metaDark:0.05 },
    vary: { h7:0.1, fracWithBg:0.08, smallUi:0.06, satMean:0.06, colorful:0.07, imgFrac:0.04, fixedFrac:0.05 },
    y: [1, 0.42, 0.42, 0.05, 0.5, 0.12] },
  { name: "LONGFORM", w: 0.06, family: "LIGHT", // wiki/docs/artigos: texto denso, serif, poucos fundos proprios
    f: { htmlBg:1.0, meanBg:0.94, h7:0.78, fracWithBg:0.22, fracDark:0.02, fracLight:0.85,
      textLum:0.12, lowContrast:0.06, contrast:0.84, satMean:0.1, satHigh:0.06, colorful:0.1,
      imgFrac:0.03, bgImgFrac:0.04, mono:0.12, fontMean:0.56, titleFrac:0.07, smallUi:0.12, fixedFrac:0.05,
      articleN:0.8, navN:0.4, tableN:0.35, formN:0.1, mediaN:0.05, metaDark:0.03 },
    vary: { h7:0.08, fracWithBg:0.06, articleN:0.15, tableN:0.15, mono:0.08, titleFrac:0.04 },
    y: [1, 0.40, 0.40, 0.30, 0.5, 0.05] },
  { name: "GALLERY", w: 0.04, family: "LIGHT", // grade de midia/streaming claro: muitas imagens e thumbs escuras
    f: { htmlBg:0.9, meanBg:0.7, h5:0.05, h6:0.1, h7:0.5, fracWithBg:0.5, fracDark:0.15, fracLight:0.5,
      textLum:0.2, lowContrast:0.1, contrast:0.72, satMean:0.3, satHigh:0.22, colorful:0.3,
      imgFrac:0.2, bgImgFrac:0.35, mono:0.02, fontMean:0.5, titleFrac:0.05, smallUi:0.14, fixedFrac:0.08,
      articleN:0.1, navN:0.6, tableN:0.03, formN:0.15, mediaN:0.8, metaDark:0.03 },
    vary: { h7:0.12, fracDark:0.06, fracLight:0.08, imgFrac:0.06, bgImgFrac:0.1, mediaN:0.1 },
    y: [1, 0.46, 0.38, 0.03, 0.5, 0.06] },
  { name: "DARK", w: 0.13, family: "DARK", // site escuro bruto: cinzas baços, contraste fraco
    f: { htmlBg:0.07, meanBg:0.11, h0:0.55, h1:0.25, fracWithBg:0.5, fracDark:0.82, fracLight:0.02,
      textLum:0.72, lowContrast:0.12, contrast:0.62, satMean:0.28, satHigh:0.15, colorful:0.2,
      imgFrac:0.05, bgImgFrac:0.05, mono:0.05, fontMean:0.55, titleFrac:0.05, smallUi:0.3, fixedFrac:0.1,
      articleN:0.35, navN:0.6, tableN:0.2, formN:0.35, mediaN:0.5, metaDark:0.8 },
    vary: { htmlBg:0.045, meanBg:0.05, h0:0.15, h1:0.1, fracDark:0.1, textLum:0.06,
      contrast:0.05, satMean:0.06, satHigh:0.08, smallUi:0.1, metaDark:0.25 },
    y: [0, 0.5, 0.2, 0.02, 0.45, 0.04] }, // dim real calculado por amostra
  { name: "BLUE_DASH", w: 0.07, family: "DARK", // dashboard escuro saturado
    f: { htmlBg:0.1, meanBg:0.15, h0:0.5, h1:0.3, fracWithBg:0.6, fracDark:0.75, fracLight:0.03,
      textLum:0.85, lowContrast:0.05, contrast:0.8, satMean:0.6, satHigh:0.7, colorful:0.7,
      imgFrac:0.04, bgImgFrac:0.08, mono:0.08, fontMean:0.5, titleFrac:0.03, smallUi:0.32, fixedFrac:0.18,
      articleN:0.15, navN:0.8, tableN:0.55, formN:0.55, mediaN:0.6, metaDark:0.5 },
    vary: { htmlBg:0.04, meanBg:0.05, h0:0.12, fracDark:0.1, contrast:0.06, satMean:0.1,
      satHigh:0.1, colorful:0.1, smallUi:0.08, fixedFrac:0.06, metaDark:0.35 },
    y: [0, 0.5, 0.25, 0.01, 0.67, 0.16] },
  { name: "DARK_POLISHED", w: 0.11, family: "DARK", // tema escuro bem desenhado (Telegram/Discord/GitHub dark)
    f: { htmlBg:0.07, meanBg:0.1, h0:0.5, h1:0.28, fracWithBg:0.45, fracDark:0.78, fracLight:0.02,
      textLum:0.87, lowContrast:0.02, contrast:0.85, satMean:0.14, satHigh:0.08, colorful:0.1,
      imgFrac:0.04, bgImgFrac:0.04, mono:0.04, fontMean:0.5, titleFrac:0.04, smallUi:0.3, fixedFrac:0.15,
      articleN:0.1, navN:0.55, tableN:0.1, formN:0.4, mediaN:0.3, metaDark:0.75 },
    vary: { htmlBg:0.04, fracDark:0.06, textLum:0.04, contrast:0.04, smallUi:0.08, fixedFrac:0.06, metaDark:0.25 },
    y: [0, 0.5, 0.2, 0.005, 0.85, 0.01] }, // retoche quase identidade
  { name: "OLED_BLACK", w: 0.06, family: "DARK", // tema preto puro (AMOLED): nao mexer
    f: { htmlBg:0.01, meanBg:0.03, h0:0.8, h1:0.12, fracWithBg:0.35, fracDark:0.92, fracLight:0.01,
      textLum:0.9, lowContrast:0.03, contrast:0.9, satMean:0.05, satHigh:0.02, colorful:0.04,
      imgFrac:0.03, bgImgFrac:0.02, mono:0.03, fontMean:0.5, titleFrac:0.03, smallUi:0.25, fixedFrac:0.1,
      articleN:0.05, navN:0.4, tableN:0.05, formN:0.3, mediaN:0.2, metaDark:0.9 },
    vary: { fracDark:0.04, textLum:0.03, contrast:0.03, metaDark:0.2 },
    y: [0, 0.5, 0.1, 0.0, 0.95, 0.0] },
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


module.exports = { ARCHETYPES, ORDER2, DIMS, IN, OUT, genDataset, archVector, rnd };
