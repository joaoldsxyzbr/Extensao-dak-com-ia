"use strict";

// Extensão Dark com IA - content script.
// Extrai features da pagina, roda a mini rede neural (nn.js) e aplica o tema.
// Nao existe ajuste manual: a rede decide tudo (e aprende com o feedback do popup).

const STYLE_ID = "darl-dark-style";
const HOST = location.hostname;
const IS_TOP = window === window.top;

const DEFAULT_SETTINGS = {
  enabled: true,
  invertMedia: true, // restaura cores originais de midias (regra classica)
  smartImages: true, // a rede de imagens decide caso a caso (icones escuros ficam claros)
  forceTheme: true, // por padrao: ignora o tema escuro do site e aplica retoque proprio
  svgFilter: false, // modo Filter+ (matriz SVG): cores mais fieis, experimental
};

let settings = null;
let weightsModel = null; // modelo da rede atualmente em uso
let imageNet = null; // rede de imagens (pesos estaticos embarcados)
let regionNet = null; // rede de regioes: blocos escuros em paginas invertidas
let features = null; // cache das features desta frame
let applied = null; // o que esta aplicado agora: { mode, invert, brightness, contrast, sepia, invertProb }
let pipelineReady = false;

// ---------------------------------------------------------------- utilidades

const clamp01 = (v) => Math.min(1, Math.max(0, v));

function lum(r, g, b) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function parseRGB(color) {
  // "rgb(a, b, c)" ou "rgba(a, b, c, alpha)"
  const m = color && color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/);
  if (!m) return null;
  return {
    r: parseFloat(m[1]),
    g: parseFloat(m[2]),
    b: parseFloat(m[3]),
    a: m[4] === undefined ? 1 : parseFloat(m[4]),
  };
}

function contrastRatio(l1, l2) {
  const hi = Math.max(l1, l2) + 0.05;
  const lo = Math.min(l1, l2) + 0.05;
  return hi / lo;
}

// ---------------------------------------------------------------- features (32)
// Ordem canonica (deve ser identica a tools/train-page-model.js):
// 0 htmlBg, 1 meanBg | 2-9 histograma de luminancia efetiva (8 faixas)
// 10 fracWithBg, 11 fracDark, 12 fracLight | 13 textLum, 14 lowContrast, 15 contrast
// 16 satMean, 17 satHigh, 18 colorful | 19 imgFrac, 20 bgImgFrac, 21 mono
// 22 fontMean, 23 titleFrac, 24 smallUi, 25 fixedFrac
// 26 articleN, 27 navN, 28 tableN, 29 formN, 30 mediaN, 31 metaDark

const FEATURE_COUNT = 32;

function inferHtmlBgLum() {
  // Fundo efetivo: o primeiro body/html com cor opaca; canvas branco como padrao.
  for (const el of [document.body, document.documentElement]) {
    if (!el) continue;
    const c = parseRGB(getComputedStyle(el).backgroundColor);
    if (c && c.a > 0.5) return lum(c.r, c.g, c.b);
  }
  return 1;
}

function metaDarkScheme() {
  for (const meta of document.querySelectorAll("meta[name='color-scheme'], meta[name='supported-color-schemes']")) {
    if ((meta.content || "").toLowerCase().includes("dark")) return 1;
  }
  return 0;
}

function countNorm(n) {
  return clamp01(Math.log(1 + Math.max(0, n)) / Math.log(61));
}

function extractFeatures() {
  // Fallback conservador: assume pagina clara enquanto nao ha DOM suficiente.
  const fallback = new Array(FEATURE_COUNT).fill(0);
  fallback[0] = 1;
  fallback[2 + 7] = 0.8; // h7
  fallback[12] = 0.8; // fracLight
  fallback[15] = 0.85; // contrast
  fallback[22] = 0.5; // fontMean
  try {
    const htmlLum = inferHtmlBgLum();
    const all = document.body ? document.body.querySelectorAll("*") : [];
    const total = all.length;
    if (total < 3) return null; // pagina ainda vazia demais
    const step = Math.max(1, Math.floor(total / 400));

    const hist = new Array(8).fill(0);
    let effLumSum = 0;
    let bgCount = 0, darkCount = 0, lightCount = 0;
    let satSum = 0, satHighCount = 0, colorfulCount = 0;
    let textLumSum = 0, textCount = 0, lowContrastCount = 0, contrastSum = 0;
    let fontSum = 0, fontCount = 0, monoCount = 0, titleCount = 0, smallCount = 0;
    let inlineBgCount = 0, fixedCount = 0, sampled = 0;

    for (let i = 0; i < total; i += step) {
      const el = all[i];
      sampled++;
      const cs = getComputedStyle(el);

      // luminancia efetiva: cor de fundo explicita ou fundo do documento
      const bg = parseRGB(cs.backgroundColor);
      let effLum = htmlLum;
      if (bg && bg.a > 0.4) {
        effLum = lum(bg.r, bg.g, bg.b);
        bgCount++;
        const mx = Math.max(bg.r, bg.g, bg.b);
        const mn = Math.min(bg.r, bg.g, bg.b);
        const sat = mx === 0 ? 0 : (mx - mn) / mx;
        satSum += sat;
        if (sat > 0.5) satHighCount++;
        if (sat > 0.4 && effLum > 0.2 && effLum < 0.9) colorfulCount++;
      }
      hist[Math.min(7, Math.floor(effLum * 8))]++;
      effLumSum += effLum;
      if (effLum < 0.25) darkCount++;
      else if (effLum > 0.75) lightCount++;

      if (cs.backgroundImage && cs.backgroundImage !== "none") inlineBgCount++;

      const fontSize = parseFloat(cs.fontSize);
      if (!Number.isNaN(fontSize)) {
        fontSum += fontSize;
        fontCount++;
        if (fontSize >= 24) titleCount++;
        else if (fontSize <= 12) smallCount++;
      }
      if ((cs.fontFamily || "").includes("mono")) monoCount++;
      if (cs.position === "fixed" || cs.position === "sticky") fixedCount++;

      const fg = parseRGB(cs.color);
      if (fg && el.childNodes.length && hasText(el)) {
        const tl = lum(fg.r, fg.g, fg.b);
        textLumSum += tl;
        const ratio = contrastRatio(tl, effLum);
        contrastSum += Math.log(1 + ratio) / Math.log(22);
        if (ratio < 3) lowContrastCount++;
        textCount++;
      }
    }

    const f = new Array(FEATURE_COUNT).fill(0);
    f[0] = clamp01(htmlLum);
    f[1] = clamp01(effLumSum / sampled);
    for (let b = 0; b < 8; b++) f[2 + b] = clamp01(hist[b] / sampled);
    f[10] = clamp01(bgCount / sampled);
    f[11] = clamp01(darkCount / sampled);
    f[12] = clamp01(lightCount / sampled);
    f[13] = textCount ? clamp01(textLumSum / textCount) : 0.15;
    f[14] = textCount ? clamp01(lowContrastCount / textCount) : 0.05;
    f[15] = textCount ? clamp01(contrastSum / textCount) : 0.8;
    f[16] = bgCount ? clamp01(satSum / bgCount) : 0.1;
    f[17] = bgCount ? clamp01(satHighCount / bgCount) : 0.08;
    f[18] = bgCount ? clamp01(colorfulCount / bgCount) : 0.12;
    f[19] = clamp01((document.images ? document.images.length : 0) / sampled * 0.5);
    f[20] = clamp01(inlineBgCount / sampled * 0.5);
    f[21] = clamp01(monoCount / sampled);
    f[22] = fontCount ? clamp01((fontSum / fontCount) / 28) : 0.5;
    f[23] = clamp01(titleCount / sampled);
    f[24] = clamp01(smallCount / sampled);
    f[25] = clamp01(fixedCount / sampled);
    f[26] = countNorm(document.querySelectorAll("article").length);
    f[27] = countNorm(document.querySelectorAll("nav").length);
    f[28] = countNorm(document.querySelectorAll("table").length);
    f[29] = countNorm(document.querySelectorAll("input, textarea, select, form").length);
    f[30] = countNorm(document.querySelectorAll("video, canvas, iframe").length);
    f[31] = metaDarkScheme();
    return f;
  } catch {
    return fallback;
  }
}

function hasText(el) {
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0) return true;
  }
  return false;
}

// ------------------------------------------------------------ imagens (rede 2)

// Cada <img> e decodificada num canvas 16x16 e a rede de imagens decide
// entre restaurar as cores originais (fotos/logos) ou manter invertida
// (icones escuros com transparencia ficariam invisiveis se revertidos).

const SIZE = 16;
const IMG_BATCH = 16;
let imgCanvas = null;
let imgQueue = [];
let imgRunning = false;

function imageFeatures(img) {
  if (!imgCanvas) {
    imgCanvas = document.createElement("canvas");
    imgCanvas.width = SIZE;
    imgCanvas.height = SIZE;
  }
  const ctx = imgCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, SIZE, SIZE);
  try {
    ctx.drawImage(img, 0, 0, SIZE, SIZE);
  } catch {
    return null; // imagem corrompida ou SVG sem dimensoes intrinsecas
  }
  let data;
  try {
    data = ctx.getImageData(0, 0, SIZE, SIZE).data;
  } catch {
    return null; // cross-origin sem CORS (canvas protegido)
  }

  let transparent = 0;
  let lumSum = 0, lumSqSum = 0, satSum = 0, dark = 0, light = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    if (a < 0.25) {
      transparent++;
      continue;
    }
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    lumSum += l;
    lumSqSum += l * l;
    satSum += mx === 0 ? 0 : (mx - mn) / mx;
    if (l < 0.3) dark++;
    else if (l > 0.7) light++;
    n++;
  }
  const total = data.length / 4;
  if (n === 0) return null; // imagem totalmente transparente: nada a decidir
  const meanLum = lumSum / n;
  const std = Math.sqrt(Math.max(0, lumSqSum / n - meanLum * meanLum));
  return [
    clamp01(transparent / total),
    clamp01(meanLum),
    clamp01(std),
    clamp01(satSum / n),
    clamp01(dark / n),
    clamp01(light / n),
  ];
}

function queueImages() {
  if (!settings || !settings.enabled || !settings.invertMedia || !settings.smartImages) return;
  if (!applied || !applied.invert) return; // so faz sentido quando a pagina esta invertida
  const imgs = document.images || [];
  for (let i = 0; i < imgs.length && imgQueue.length < 400; i++) {
    const img = imgs[i];
    const src = img.currentSrc || img.src || "";
    if (!src || img.dataset.ddSrc === src || img.dataset.ddQueued) continue;
    img.dataset.ddQueued = "1";
    imgQueue.push(img);
  }
  if (imgQueue.length) runImageQueue();
}

async function runImageQueue() {
  if (imgRunning) return;
  imgRunning = true;
  while (imgQueue.length) {
    classifyImage(imgQueue.shift());
    if (imgQueue.length && imgQueue.length % IMG_BATCH === 0) {
      // cede a thread entre lotes para nao travar a rolagem
      await new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(r) : setTimeout(r, 0)));
    }
  }
  imgRunning = false;
}

function classifyImage(img) {
  delete img.dataset.ddQueued;
  const src = img.currentSrc || img.src || "";
  img.dataset.ddSrc = src;
  if (!src || !imageNet) return;
  if (!img.complete || img.naturalWidth === 0) {
    img.addEventListener("load", () => classifyImage(img), { once: true });
    return;
  }
  const f = imageFeatures(img);
  if (!f) return; // sem leitura de pixels: fica no padrao (reverter cores)
  try {
    const { p } = DarlNN.forward(imageNet, f);
    if (p[0] > 0.5) img.classList.add("dd-keep");
    else img.classList.remove("dd-keep");
  } catch {
    /* decisao falhou: mantem padrao */
  }
}

// ---------------------------------------------------------------- decisao

function hasLockMeta() {
  // Paginas podem pedir exclusao (convencao do Dark Reader, adotada aqui).
  return Boolean(document.querySelector("meta[name='darkreader-lock']"));
}

function forcedColorsActive() {
  try {
    return typeof matchMedia === "function" && matchMedia("(forced-colors: active)").matches;
  } catch {
    return false;
  }
}

function computeDecision() {
  if (!settings || !settings.enabled) return { off: true };
  if (!features || !weightsModel) return null; // IA ainda nao pronta nesta frame

  // Acessibilidade primeiro: modo de cores forçadas do SO fica intacto.
  if (forcedColorsActive()) return { mode: "auto", off: true, skip: true, forced: true };
  // O site pediu exclusao: a IA respeita.
  if (hasLockMeta()) return { mode: "auto", off: true, invertProb: 0, skip: true, lock: true };

  const { p } = DarlNN.forward(weightsModel, features);
  const invert = p[0] > 0.5;
  // Confianca calibrada por temperatura: a porcentagem do popup e honesta.
  const invertProb = Math.round(DarlNN.calibrate(p[0], PAGE_TEMP) * 100) / 100;
  const sepia = 0.5 * p[3];
  // Piso leve de dessaturacao: reduz halation (branco puro cansa em fundo escuro).
  const tint = Math.max(0.03, 0.25 * p[5]);

  // Site ja escuro: sem forceTheme, a extensao deixa a pagina em paz.
  if (!invert && !settings.forceTheme) {
    return { mode: "auto", off: true, invertProb, skip: true };
  }

  if (invert) {
    // Site claro: inverte com knobs do modelo e limites WCAG:
    // contraste no maximo 0.95 (preto invertido nao vira #000 puro) e piso de brilho.
    return {
      mode: "auto", invert: true, invertProb,
      brightness: Math.max(0.75, 0.6 + 0.8 * p[1]),
      contrast: Math.min(0.9, Math.max(0.8, 0.6 + 0.8 * p[2])),
      sepia, tint,
    };
  }

  // Site ja escuro com forceTheme (padrao): retoque escuro da IA.
  return {
    mode: "auto", invert: false, invertProb,
    brightness: 0.7 + 0.3 * p[4],
    contrast: 0.9 + 0.25 * p[2],
    sepia, tint,
  };
}

// ------------------------------------------------- modo SVG (Filter+ / matriz)

const SVG_HOST_ID = "darl-svg-host";
const MATRIX_ID = "darl-matrix";
const REVERT_ID = "darl-matrix-revert";

function ensureSvgFilters(decision) {
  const values = DarlMatrix.toSVGMatrixString(
    DarlMatrix.composeDarkMatrix({
      sepia: decision.sepia || 0,
      grayscale: decision.tint || 0,
      contrast: decision.contrast || 1,
      brightness: decision.brightness || 1,
    })
  );
  const revert = DarlMatrix.toSVGMatrixString(DarlMatrix.invertNHue());

  let host = document.getElementById(SVG_HOST_ID);
  if (!host) {
    host = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    host.id = SVG_HOST_ID;
    host.setAttribute("width", "0");
    host.setAttribute("height", "0");
    host.style.position = "absolute";
    host.innerHTML = `
<defs>
<filter id="${MATRIX_ID}" style="color-interpolation-filters: sRGB">
<feColorMatrix type="matrix" values="${values}" />
</filter>
<filter id="${REVERT_ID}" style="color-interpolation-filters: sRGB">
<feColorMatrix type="matrix" values="${revert}" />
</filter>
</defs>`;
    (document.documentElement || document.body).appendChild(host);
    return;
  }
  const m = host.querySelector("#" + MATRIX_ID + " feColorMatrix");
  if (m && m.getAttribute("values") !== values) m.setAttribute("values", values);
}

function removeSvgFilters() {
  const host = document.getElementById(SVG_HOST_ID);
  if (host) host.remove();
}

function buildCSS(decision) {
  const norm = (v) => Math.round(v * 100) / 100;
  const extras =
    (decision.sepia > 0.02 ? ` sepia(${norm(decision.sepia)})` : "") +
    (decision.tint > 0.02 ? ` grayscale(${norm(decision.tint)})` : "");
  const printGuard = `
@media print {
  html { filter: none !important; background: initial !important; background-color: initial !important; }
}`;

  if (!decision.invert) {
    // Site ja escuro (forceTheme): leve retoque de uniformizacao, mantendo escuro.
    return `
html {
  filter: brightness(${norm(decision.brightness)}) contrast(${norm(decision.contrast)})${extras} !important;
}${printGuard}`;
  }

  if (settings.svgFilter) {
    // Modo Filter+ (matriz SVG): a cadeia inteira e uma unica feColorMatrix,
    // mais fiel aos matizes (invertNHue preserva o hue). Reverso = a propria
    // invertNHue, involutiva. Media e regioes restauram com o reverso.
    ensureSvgFilters(decision);
    let css = `
html {
  filter: url(#${MATRIX_ID}) !important;
  background: #ffffff !important;
  background-color: #ffffff !important;
}`;
    if (settings.invertMedia) {
      css += `
img, video, picture, canvas, iframe, embed, object, image,
[style*="url("] {
  filter: url(#${REVERT_ID}) !important;
}`;
    }
    if (settings.smartImages) {
      css += `
img.dd-keep {
  filter: none !important;
}`;
    }
    css += `
.dd-region {
  filter: url(#${REVERT_ID}) !important;
}`;
    return css + printGuard;
  }

  let css = `
html {
  filter: invert(1) hue-rotate(180deg) brightness(${norm(decision.brightness)}) contrast(${norm(decision.contrast)})${extras} !important;
  background: #ffffff !important;
  background-color: #ffffff !important;
}`;
  if (settings.invertMedia) {
    css += `
img, video, picture, canvas, iframe, embed, object, image,
[style*="url("] {
  filter: invert(1) hue-rotate(180deg) !important;
}`;
  }
  if (settings.smartImages) {
    // A rede de imagens marca icones/logos escuros: sem o reverter, eles ficam
    // pretos em fundo escuro (invisiveis). Mantendo invertidos, viram claros.
    css += `
img.dd-keep {
  filter: none !important;
}`;
  }
  // Blocos escuros: a inversao da pagina e neutralizada e o bloco
  // permanece com as cores originais (decisao da rede de regioes).
  css += `
.dd-region {
  filter: invert(1) hue-rotate(180deg) !important;
}`;
  return css + printGuard;
}

function apply(decision) {
  const root = document.documentElement;
  if (!root) return;
  const style = document.getElementById(STYLE_ID);

  if (!decision || decision.off) {
    if (style) style.remove();
    applied = decision ? { ...decision, css: false } : { off: true };
    clearRegions();
    removeSvgFilters();
    reveal();
    return;
  }

  let el = style;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    root.appendChild(el);
  }
  if (!decision.invert || !settings.svgFilter) {
    removeSvgFilters(); // modo clasico: nao deixa svg obsoleto no DOM
  }
  const css = buildCSS(decision);
  if (el.textContent !== css) el.textContent = css; // evita mutacoes desnecessarias (loop com o observer)
  applied = { ...decision, css: true };
  reveal();
  if (decision.invert) maybeRegions();
  else clearRegions();
}

function refresh() {
  try {
    const decision = computeDecision();
    if (decision === null) return; // IA ainda nao pronta: nao mexe no estado atual
    apply(decision);
    cacheDecision(decision);
    queueImages();
  } catch (err) {
    // Nunca deixar a analise quebrar a pagina de hospedagem.
    console.warn("Extensão Dark com IA: falha ao aplicar tema", err);
  }
}

// ---------------------------------------------------------------- boot cover (anti-flash)
// Paginas claras pintariam branco antes da analise: a extensao abre com uma
// tampa escura e revela o conteudo ja com o tema aplicado. Cache de host + tampa
// tornam o flash invisivel; a tampa tem timeout de seguranca inexoravel.

const BOOT_CLASS = "darl-boot";
const COVER_ID = "darl-flash-cover";
const COVER_MAX_MS = 450;
let bootTimer = null;

function installCover() {
  if (document.readyState !== "loading") return; // injecao tardia: nao tampa o que ja apareceu
  try {
    const root = document.documentElement;
    root.classList.add(BOOT_CLASS);
    const el = document.createElement("style");
    el.id = COVER_ID;
    el.textContent = `
html.darl-boot { background: #0e1019 !important; }
html.darl-boot > * { visibility: hidden !important; }`;
    root.appendChild(el);
    bootTimer = setTimeout(reveal, COVER_MAX_MS);
  } catch {
    /* se a tampa falhar, a pagina simplesmente carrega como sem extensao */
  }
}

function reveal() {
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  document.documentElement.classList.remove(BOOT_CLASS);
  const el = document.getElementById(COVER_ID);
  if (el) el.remove();
}


// ---------------------------------------------------------------- regioes (rede 3)
// Em paginas invertidas, blocos grandes com fundo escuro (headers, footers, heros,
// cards de codigo) ficam com a cor original: a rede decide por regiao e a classe
// .dd-region neutraliza a inversao do bloco. Resolve paginas mistas sem virar
// o header claro-depois-de-invertido.

const REGION_MIN_AREA = 0.015;
const REGION_MAX = 24;
const REGION_THROTTLE_MS = 3000;
const REGION_CLASS = "dd-region";
const MEDIA_TAGS = new Set(["IMG", "VIDEO", "PICTURE", "CANVAS", "IFRAME", "SVG", "OBJECT", "EMBED"]);
let regionMarked = [];
let lastRegionRun = 0;

function clearRegions() {
  for (const el of regionMarked) el.classList.remove(REGION_CLASS);
  regionMarked = [];
}

function maybeRegions() {
  const now = Date.now();
  if (now - lastRegionRun < REGION_THROTTLE_MS) return;
  lastRegionRun = now;
  decideRegions();
}

function regionCandidates() {
  const root = document.documentElement;
  const vw = Math.max(root.clientWidth || 1, 1);
  const vh = Math.max(root.clientHeight || 1, 1);
  const pageArea = vw * vh;
  const all = document.body ? document.body.querySelectorAll("*") : [];
  const step = Math.max(1, Math.floor(all.length / 600));

  const candidates = [];
  for (let i = 0; i < all.length; i += step) {
    const el = all[i];
    if (MEDIA_TAGS.has(el.tagName)) continue;
    const cs = getComputedStyle(el);
    const bg = parseRGB(cs.backgroundColor);
    if (!bg || bg.a <= 0.5) continue; // regiao precisa de fundo proprio opaco
    const l = lum(bg.r, bg.g, bg.b);
    if (l > 0.5) continue; // so blocos escurecidos importam em pagina invertida
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const areaFrac = (rect.width * rect.height) / pageArea;
    if (areaFrac < REGION_MIN_AREA) continue;
    candidates.push({ el, cs, bg, l, areaFrac });
  }

  // maiores primeiro; descendentes de candidatos escolhidos sao ignorados
  candidates.sort((a, b) => b.areaFrac - a.areaFrac);
  const chosen = [];
  for (const c of candidates) {
    if (chosen.length >= REGION_MAX) break;
    if (chosen.some((o) => o.el.contains(c.el))) continue;
    chosen.push(c);
  }
  return chosen;
}

// Features da regiao (ordem identica a tools/train-region-model.js):
// [lum, sat, textLum, contrast, areaFrac, isFixed, hasBgImg, childMediaFrac]
function regionFeatures(c) {
  let textLumSum = 0, textCount = 0, contrastSum = 0;
  let mediaCount = 0, childSampled = 0;
  const walk = c.el.querySelectorAll("*");
  const step = Math.max(1, Math.floor(walk.length / 40));
  for (let i = 0; i < walk.length; i += step) {
    const child = walk[i];
    childSampled++;
    const cs = getComputedStyle(child);
    const fg = parseRGB(cs.color);
    if (fg && child.childNodes.length && hasText(child)) {
      const tl = lum(fg.r, fg.g, fg.b);
      textLumSum += tl;
      contrastSum += Math.log(1 + contrastRatio(tl, c.l)) / Math.log(22);
      textCount++;
    }
    if (MEDIA_TAGS.has(child.tagName)) mediaCount++;
  }
  const mx = Math.max(c.bg.r, c.bg.g, c.bg.b);
  const mn = Math.min(c.bg.r, c.bg.g, c.bg.b);
  return [
    clamp01(c.l),
    clamp01(mx === 0 ? 0 : (mx - mn) / mx),
    textCount ? clamp01(textLumSum / textCount) : 0.8,
    textCount ? clamp01(contrastSum / textCount) : 0.7,
    clamp01(c.areaFrac),
    c.cs.position === "fixed" || c.cs.position === "sticky" ? 1 : 0,
    c.cs.backgroundImage && c.cs.backgroundImage !== "none" ? 1 : 0,
    childSampled ? clamp01(mediaCount / childSampled) : 0,
  ];
}

function decideRegions() {
  if (!regionNet || !settings || !settings.enabled) {
    clearRegions();
    return;
  }
  let marked = [];
  try {
    for (const c of regionCandidates()) {
      try {
        const { p } = DarlNN.forward(regionNet, regionFeatures(c));
        if (p[0] > 0.5) marked.push(c.el);
      } catch {
        /* candidato com estilo imparsavel: segue a pagina */
      }
    }
  } catch {
    marked = [];
  }
  for (const el of regionMarked) {
    if (!marked.includes(el)) el.classList.remove(REGION_CLASS);
  }
  for (const el of marked) el.classList.add(REGION_CLASS);
  regionMarked = marked;
}

// ---------------------------------------------------------------- estado

// Memoriza a ultima decisao da rede para este host (anti-flash na proxima visita).
let lastCacheJson = "";
function cacheDecision(decision) {
  if (!IS_TOP || !decision || decision.off || decision.mode !== "auto") return;
  const slim = {
    mode: "auto",
    invert: decision.invert,
    brightness: decision.brightness,
    contrast: decision.contrast,
    sepia: decision.sepia,
    tint: decision.tint,
    invertProb: decision.invertProb,
  };
  const json = JSON.stringify(slim);
  if (json === lastCacheJson) return;
  lastCacheJson = json;
  chrome.storage.local.get("hostCache", (res) => {
    if (chrome.runtime.lastError) return;
    const cache = (res && res.hostCache) || {};
    cache[HOST] = slim;
    const keys = Object.keys(cache);
    for (let i = 0; keys.length - i > 300; i++) delete cache[keys[i]]; // limite de 300 hosts
    chrome.storage.local.set({ hostCache: cache }, () => void chrome.runtime.lastError);
  });
}

// Modelos estaticos embutidos: a extensao e inference-only. Treino acontece
// offline, pelos treinadores em tools/ (pipeline nnlab), e chega aqui embutido.
const PAGE_TEMP = globalThis.DARL_PAGE_WEIGHTS && globalThis.DARL_PAGE_WEIGHTS.temp ? globalThis.DARL_PAGE_WEIGHTS.temp : 1;

function loadState() {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (sync) => {
    if (chrome.runtime.lastError) return;
    settings = { ...DEFAULT_SETTINGS, ...sync };
    chrome.storage.local.get("hostCache", (local) => {
      if (chrome.runtime.lastError) return;
      weightsModel = DarlNN.makeNet(globalThis.DARL_PAGE_WEIGHTS.dims, globalThis.DARL_PAGE_WEIGHTS);
      if (!imageNet && globalThis.DARL_IMAGE_WEIGHTS) {
        imageNet = DarlNN.makeNet(globalThis.DARL_IMAGE_WEIGHTS.dims, globalThis.DARL_IMAGE_WEIGHTS);
      }
      if (!regionNet && globalThis.DARL_REGION_WEIGHTS) {
        regionNet = DarlNN.makeNet(globalThis.DARL_REGION_WEIGHTS.dims, globalThis.DARL_REGION_WEIGHTS);
      }
      pipelineReady = true;

      // Tema provisorio memorizado deste host (anti-flash): aplica imediatamente
      // enquanto a analise da rede neural ainda nao rodou nesta visita.
      const cached = local && local.hostCache ? local.hostCache[HOST] : null;
      if (!applied && settings.enabled && !features && cached) {
        try {
          apply(cached);
        } catch {
          /* cache invalido: ignora e espera a analise real */
        }
      }

      refresh();
    });
  });
}

function extractAndRefresh() {
  features = extractFeatures();
  lastExtractAt = Date.now();
  refresh();
}

// ------------------------------------------------------- reanalise de SPAs

// YouTube, Reddit etc. trocam de tema (claro/escuro) sem recarregar a pagina.
// Quando o DOM muda muito, reextrai as features (com throttle) e a rede
// decide de novo - inclusive remover o tema se o site ficou escuro por conta.
const RE_ANALYZE_MS = 5000;
const MIN_MUTATIONS = 40;
let lastExtractAt = 0;
let mutationCount = 0;
let reAnalyzeTimer = null;

function scheduleReAnalyze() {
  mutationCount++;
  if (document.hidden || reAnalyzeTimer !== null) return;
  if (mutationCount < MIN_MUTATIONS) return;
  const passed = Date.now() - lastExtractAt;
  const wait = passed < RE_ANALYZE_MS ? RE_ANALYZE_MS - passed + 500 : 500;
  reAnalyzeTimer = setTimeout(() => {
    reAnalyzeTimer = null;
    mutationCount = 0;
    if (!document.hidden) extractAndRefresh();
  }, wait);
}

function watchMutations() {
  if (!IS_TOP || typeof MutationObserver !== "function") return;
  new MutationObserver(scheduleReAnalyze).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style"],
  });
}

function start() {
  installCover();
  const onReady = () => {
    extractAndRefresh();
    watchMutations();
    // paginas que montam o layout depois: reanalisa no load completo
    if (document.readyState !== "complete") {
      window.addEventListener("load", extractAndRefresh, { once: true });
    }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onReady, { once: true });
  } else {
    onReady();
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") loadState();
  if (area === "local" && changes.nnWeights) loadState();
});

// Popup pedindo estado da aba (responde apenas a frame do topo).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !IS_TOP) return undefined;
  if (msg.type === "darl-get-state") {
    sendResponse({
      ready: pipelineReady && features !== null,
      hasFeatures: features !== null,
      features,
      applied,
      pageMode: applied && applied.mode ? applied.mode : "auto",
    });
    return undefined;
  }
  if (msg.type === "darl-refresh") {
    try {
      extractAndRefresh();
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
    return undefined;
  }
  return undefined;
});

loadState();
start();
