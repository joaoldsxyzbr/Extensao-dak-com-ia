"use strict";

// Extensão Dark com IA - content script.
// Extrai features da pagina (darl-features.js), roda a mini rede neural
// (nn.js) e aplica o tema - por elemento (element.js) ou por filtro global.

const STYLE_ID = "darl-dark-style";
const HOST = location.hostname;
const IS_TOP = window === window.top;

const DEFAULT_SETTINGS = {
  enabled: true,
  invertMedia: true, // restaura cores originais de midias (regra classica)
  smartImages: true, // a rede de imagens decide caso a caso (icones escuros ficam claros)
  forceTheme: true, // por padrao: ignora o tema escuro do site e aplica retoque proprio
  svgFilter: false, // modo Filter+ (matriz SVG): cores mais fieis, experimental
  elementMode: true, // v4: analise por elemento em vez de filtro de inversao global
};

let settings = null;
let weightsModel = null; // modelo da rede atualmente em uso
let imageNet = null; // rede de imagens (pesos estaticos embarcados)
let regionNet = null; // rede de regioes: blocos escuros em paginas invertidas
let features = null; // cache das features desta frame
let applied = null; // o que esta aplicado agora: { mode, invert, brightness, contrast, sepia, invertProb }
let pipelineReady = false;
// v4.3.2: paginas gigantes que estouram o teto do motor caem no filtro classico.
// Sem este lacre, o re-scan de SPA re-entrava no motor, estourava de novo e a
// pagina oscilava entre meio-remapeada e invertida sem parar. Uma vez caida,
// fica no filtro ate a proxima navegacao (o script recarrega e reseta).
let engineFellBack = false;

// ---------------------------------------------------------------- utilidades

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// ---------------------------------------------------------------- features (32)
// A extracao mora em darl-features.js (modulo compartilhado com o crawler
// de dados reais). A ordem das 32 features e canonica em tres lugares:
// darl-features.js, tools/train-page-model.js e tools/test-nn.js.

const FEATURE_COUNT = DarlFeatures.FEATURE_COUNT;
const { parseRGB, lum, contrastRatio, hasText } = DarlFeatures;

function extractFeatures() {
  // Os estilos da propria extensao nao podem poluir as features na reanálise:
  // sao desligados durante a leitura e religados no mesmo tick (darl-features).
  return DarlFeatures.extract({
    skipStyleIds: [STYLE_ID, COVER_ID, DarlElement.STYLE_ID],
  });
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

  const { p } = DarlModel.forward(weightsModel, features);
  const invert = p[0] > 0.5;
  // Confianca calibrada por temperatura: a porcentagem do popup e honesta.
  const invertProb = Math.round(DarlNN.calibrate(p[0], weightsModel.temp) * 100) / 100;
  const sepia = 0.5 * p[3];
  // Piso leve de dessaturacao: reduz halation (branco puro cansa em fundo escuro).
  const tint = Math.max(0.03, 0.25 * p[5]);

  // Site ja escuro: sem forceTheme, a extensao deixa a pagina em paz.
  if (!invert && !settings.forceTheme) {
    return { mode: "auto", off: true, invertProb, skip: true };
  }

  if (invert) {
    // Site claro: decide como inverter. O motor por elemento (v4) remapeia
    // cor por cor em vez de filtrar a pagina inteira; o modo filtro classico
    // (ou a matriz SVG) continua disponivel nas opcoes.
    const engine = (settings.elementMode !== false && !settings.svgFilter) ? "elements" : "filter";
    // Site claro: inverte com knobs do modelo e limites WCAG:
    // contraste no maximo 0.95 (preto invertido nao vira #000 puro) e piso de brilho.
    return {
      mode: "auto", invert: true, invertProb, engine,
      brightness: Math.max(0.75, 0.6 + 0.8 * p[1]),
      contrast: Math.min(0.9, Math.max(0.8, 0.6 + 0.8 * p[2])),
      sepia, tint,
    };
  }

  // Site ja escuro com forceTheme (padrao): retoque escuro da IA.
  return {
    mode: "auto", invert: false, invertProb, engine: "retoque",
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
    if (typeof DarlElement !== "undefined") DarlElement.stop();
    stopFrameEngines(); // frames about:blank voltam ao original junto com o topo
    clearRegions();
    removeSvgFilters();
    reveal();
    return;
  }

  // Motor por elemento (v4): remapeia cor por cor; a tampa anti-flash so
  // levanta quando o primeiro lote de regras foi aplicado (hooks.onApplied).
  // Pagina grande demais ou erro na varredura -> fallback para o filtro
  // (estavel: o lacre engineFellBack impede a oscilacao motor<->filtro).
  if (decision.engine === "elements") {
    if (style) style.remove();
    removeSvgFilters();
    if (!engineFellBack) {
      if (!DarlElement.isActive()) {
        DarlElement.start(decision, {
          onApplied: reveal,
          onFallback: () => {
            engineFellBack = true;
            apply({ ...decision, engine: "filter" });
          },
        });
      }
      applied = { ...decision, css: true };
      clearRegions(); // sem filtro global, nao ha regioes para neutralizar
      queueImages();
      scheduleFramePass(); // iframes about:blank/srcdoc sem script proprio (v4.3.4)
      return;
    }
    decision = { ...decision, engine: "filter" }; // lacre: segue como filtro
  }

  if (DarlElement.isActive()) DarlElement.stop();
  stopFrameEngines(); // no filtro o iframe e midia (conteudo original revertido)
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
    logDecision(decision);
    queueImages();
  } catch (err) {
    // Nunca deixar a analise quebrar a pagina de hospedagem.
    console.warn("Extensão Dark com IA: falha ao aplicar tema", err);
  }
}

// ------------------------------------------------------- dados de navegacao
// Registro local e anonimo (so o host, sem querystring) das decisoes reais
// da IA com as features vistas - a materia-prima do retreino com dados
// reais. Exportavel pelo popup ("Exportar dados"); nada sai do navegador
// a nao ser quando o usuario baixa o arquivo.

let lastLogJson = "";
function logDecision(decision) {
  if (!IS_TOP || !decision || decision.off || !features) return;
  try {
    const rec = {
      t: Date.now(),
      host: HOST,
      path: location.pathname.slice(0, 120),
      engine: decision.engine || (decision.invert ? "filter" : "retoque"),
      invert: !!decision.invert,
      invertProb: typeof decision.invertProb === "number" ? decision.invertProb : null,
      features: features.map((v) => Math.round(v * 1000) / 1000),
    };
    const json = JSON.stringify(rec);
    if (json === lastLogJson) return; // mesma decisao: nao repete registro
    lastLogJson = json;
    chrome.storage.local.get({ dataLog: [] }, (res) => {
      if (chrome.runtime.lastError) return;
      const log = Array.isArray(res.dataLog) ? res.dataLog : [];
      log.push(rec);
      while (log.length > 500) log.shift(); // teto: 500 paginas
      chrome.storage.local.set({ dataLog: log }, () => void chrome.runtime.lastError);
    });
  } catch {
    /* log e best-effort: nunca atrapalha a navegacao */
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

// -------------------------------------- frames sem content script (v4.3.4)
//
// O MV3 injeta o content script em frames http(s) (all_frames), mas NAO em
// about:blank/srcdoc: editores embutidos, viewers de preview e caixas de
// texto rica (caso Rocket.Chat, Gmail) ficavam paineis brancos no meio do
// tema escuro. Frames de mesma origem sao acessiveis pelo documento topo
// (iframe.contentDocument): o topo estende o motor por elemento para
// dentro deles, com os MESMOS mapeadores puros do DarlElement. Frames com
// URL propria (http/https) tem content script proprio e decidem por si -
// cada frame e analisado como pagina. No modo filtro o iframe e tratado
// como midia (conteudo original revertido), como sempre foi.

const FRAME_STYLE_ID = "darl-frame-style";
const FRAME_MARK = "darl-frame-el";
const FRAME_TEXTISH = new Set(["INPUT", "TEXTAREA", "SELECT", "OPTION", "BUTTON", "A", "LABEL", "SUMMARY"]);
const FRAME_SCAN_MS = 24; // orcamento por lote, igual ao element.js
const FRAME_FLUSH_MS = 400; // throttle de flush do <style> do frame
const FRAME_MAX_ELEMENTS = 5000; // frames sao cascas menores que a pagina
const FRAME_PASS_DELAY_MS = 300;

let frameEngines = []; // { win, doc, styleEl, queue, markId, ruleBuffer, lastFlushAt, observer, scanning, stopped }
let framePassTimer = null;
const frameLoadHandled = new WeakSet(); // iframes com listener de "load" anexado

function frameIsQueueable(node) {
  if (!node || node.nodeType !== 1) return false;
  // isQueueableNode filtra tags inuteis e os <style> da extensao do topo;
  // aqui falta so o style do proprio frame
  return DarlElement.isQueueableNode(node) && node.id !== FRAME_STYLE_ID;
}

// Regra de um elemento do frame: espelha o elementRule do element.js, com o
// getComputedStyle do PROPRIO frame (cada janela tem o seu) e os mesmos
// mapeadores puros (mapBackground/mapText/mapNeutral/gradientes/sombras).
function frameRule(eng, el, id) {
  const cs = eng.win.getComputedStyle(el);
  const parts = [];
  const { BG_LIGHT, TEXT_DARK, CANVAS_L } = DarlElement._internals;

  const bg = parseRGB(cs.backgroundColor);
  const fg = parseRGB(cs.color);
  const needsText =
    (el.childNodes && Array.prototype.some.call(el.childNodes, (n) => n.nodeType === 3 && n.textContent.trim())) ||
    FRAME_TEXTISH.has(el.tagName);
  const fgDark = Boolean(fg) && needsText && DarlElement.lum255(fg.r, fg.g, fg.b) <= TEXT_DARK;

  let bgLum = CANVAS_L;
  if (bg && bg.a > 0.04) {
    const bl = DarlElement.lum255(bg.r, bg.g, bg.b);
    if (bl >= BG_LIGHT) {
      // acento vivo (dot/badge): minusculo, saturado e sem texto escuro
      // proprio mantem a cor original, como no documento topo
      let accent = false;
      if (!fgDark && DarlElement.isAccentColor(bg)) {
        try {
          const rect = el.getBoundingClientRect();
          accent = DarlElement.isAccentSize(rect.width, rect.height);
        } catch {
          accent = false;
        }
      }
      if (accent) {
        bgLum = bl; // a cor viva ficou: textos herdeiros medem contra ela
      } else {
        const m = DarlElement.mapBackground(bg);
        parts.push(`background-color: ${m.css} !important`);
        bgLum = m.lum;
      }
    } else if (bg.a >= 0.98) {
      bgLum = bl; // fundo ja escuro: textos devem se medir contra ele
    }
  }

  if (fg && needsText) {
    const fl = DarlElement.lum255(fg.r, fg.g, fg.b);
    if (fl <= TEXT_DARK) {
      const m = DarlElement.mapText(fg, bgLum);
      parts.push(`color: ${m.css} !important`);
    }
  }

  const borderSeen = new Set();
  for (const b of ["borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor"]) {
    const bc = parseRGB(cs[b]);
    if (!bc) continue;
    const key = bc.r + "," + bc.g + "," + bc.b + "," + bc.a;
    if (borderSeen.has(key)) continue;
    borderSeen.add(key);
    if (DarlElement.lum255(bc.r, bc.g, bc.b) >= 0.30) {
      const m = DarlElement.mapNeutral(bc, bgLum);
      if (m.css) parts.push(`${b.replace(/[A-Z]/g, (ch) => "-" + ch.toLowerCase())}: ${m.css} !important`);
    }
  }

  const bi = cs.backgroundImage;
  if (typeof bi === "string" && bi.includes("gradient(")) {
    const g = DarlElement.remapGradient(bi);
    if (g) parts.push(`background-image: ${g} !important`);
  }
  const sh = cs.boxShadow;
  if (typeof sh === "string" && sh && sh !== "none") {
    const s = DarlElement.remapShadow(sh, bgLum);
    if (s) parts.push(`box-shadow: ${s} !important`);
  }
  const fill = parseRGB(cs.fill);
  if (fill && DarlElement.lum255(fill.r, fill.g, fill.b) <= TEXT_DARK && fill.a > 0.04) {
    parts.push(`fill: ${DarlElement.mapText(fill, bgLum).css} !important`);
  }
  const stroke = parseRGB(cs.stroke);
  if (stroke && DarlElement.lum255(stroke.r, stroke.g, stroke.b) <= TEXT_DARK && stroke.a > 0.04) {
    parts.push(`stroke: ${DarlElement.mapText(stroke, bgLum).css} !important`);
  }

  if (!parts.length) return "";
  el.setAttribute(FRAME_MARK, String(id));
  return `[${FRAME_MARK}="${id}"] { ${parts.join("; ")}; }`;
}

// Flush incremental com throttle, como o element.js: cada flush no frame
// custa recalculo de estilo do frame inteiro.
function frameFlush(eng, force) {
  if (!eng.styleEl || !eng.ruleBuffer.length) return;
  if (!force) {
    const now = Date.now();
    if (now - eng.lastFlushAt < FRAME_FLUSH_MS) return;
  }
  try {
    eng.styleEl.appendChild(eng.doc.createTextNode("\n" + eng.ruleBuffer.join("\n")));
  } catch {
    return; // doc destruido entre o lote e o flush
  }
  eng.ruleBuffer = [];
  eng.lastFlushAt = Date.now();
}

function frameScanBatch(eng) {
  if (eng.stopped || !eng.queue.length) {
    eng.scanning = false;
    return;
  }
  const t0 = Date.now();
  const rules = [];
  while (eng.queue.length && Date.now() - t0 < FRAME_SCAN_MS) {
    const el = eng.queue.shift();
    if (!el.isConnected) continue;
    if (el.hasAttribute && el.hasAttribute(FRAME_MARK)) continue;
    if (!frameIsQueueable(el)) continue;
    try {
      const rule = frameRule(eng, el, ++eng.markId);
      if (rule) rules.push(rule);
      else el.setAttribute(FRAME_MARK, String(++eng.markId)); // marca mesmo sem regra
    } catch {
      /* estilo imparsavel: segue o proximo */
    }
    if (eng.markId > FRAME_MAX_ELEMENTS) break;
  }
  if (rules.length) {
    eng.ruleBuffer.push(...rules);
    frameFlush(eng, false);
  }
  if (eng.queue.length && eng.markId <= FRAME_MAX_ELEMENTS) {
    const step = () => frameScanBatch(eng);
    if (window.requestIdleCallback) requestIdleCallback(step, { timeout: 400 });
    else setTimeout(step, 16);
  } else {
    eng.scanning = false;
    frameFlush(eng, true); // varredura acabou: entrega o que sobrou
  }
}

function frameScheduleScan(eng) {
  if (eng.stopped || eng.scanning || !eng.queue.length) return;
  eng.scanning = true;
  const step = () => frameScanBatch(eng);
  if (window.requestIdleCallback) requestIdleCallback(step, { timeout: 400 });
  else setTimeout(step, 16);
}

// Fila do frame guiada por mutacoes (mesma logica do element.js): editores
// escrevem no DOM sem parar; reconsultar o frame inteiro e que nao pode.
function frameQueueMutations(eng, muts) {
  if (eng.stopped) return;
  let fresh = false;
  for (const m of muts) {
    const added = m.addedNodes;
    if (!added || !added.length) continue;
    for (let i = 0; i < added.length; i++) {
      const n = added[i];
      if (!frameIsQueueable(n)) continue;
      eng.queue.push(n);
      fresh = true;
      if (n.querySelectorAll) {
        for (const c of n.querySelectorAll("*")) {
          if (frameIsQueueable(c)) eng.queue.push(c);
        }
      }
    }
  }
  if (fresh) frameScheduleScan(eng);
}

function attachFrame(iframe) {
  let win = null;
  let doc = null;
  let url = "";
  try {
    win = iframe.contentWindow;
    doc = iframe.contentDocument;
    url = (doc && doc.URL) || "";
  } catch {
    return; // cross-origin: inacessivel (e tem script proprio se for http)
  }
  if (!win || !doc || !doc.documentElement) return; // ainda escrevendo: o "load" agenda nova passada
  if (!DarlElement.isUnscriptedFrameURL(url)) return; // http(s): content script proprio
  if (frameEngines.some((e) => e.doc === doc)) return; // ja anexado

  let styleEl = null;
  try {
    styleEl = doc.createElement("style");
    styleEl.id = FRAME_STYLE_ID;
    doc.documentElement.appendChild(styleEl);
    styleEl.textContent = "html { background-color: #17181d !important; color-scheme: dark !important; }";
  } catch {
    return; // doc hostil: deixa o frame como esta
  }
  const eng = {
    win, doc, styleEl,
    queue: [doc.documentElement, doc.body].filter(Boolean),
    markId: 0, ruleBuffer: [], lastFlushAt: 0,
    observer: null, scanning: false, stopped: false,
  };
  if (doc.body) eng.queue.push(...doc.body.querySelectorAll("*"));
  frameEngines.push(eng);
  if (typeof MutationObserver === "function") {
    eng.observer = new MutationObserver((muts) => frameQueueMutations(eng, muts));
    eng.observer.observe(doc.documentElement, { childList: true, subtree: true });
  }
  frameScheduleScan(eng);
}

// Uma passada: descobre iframes about:blank/srcdoc ainda sem tema. Roda no
// apply() do motor por elemento, nas mutacoes que criam iframes e no
// "load" de cada iframe (recarregou -> documento novo -> novo engine).
function framePass() {
  if (!applied || applied.off || !applied.invert || applied.engine !== "elements") return;
  // higiene: engines de iframes que recarregaram/sumiram (doc desconectado)
  try {
    frameEngines = frameEngines.filter((e) => !e.stopped && e.doc.isConnected !== false);
  } catch {
    /* segue com a lista como esta */
  }
  let iframes = [];
  try {
    iframes = Array.prototype.slice.call(document.getElementsByTagName("iframe"));
  } catch {
    return;
  }
  for (const f of iframes) {
    try {
      if (!frameLoadHandled.has(f)) {
        frameLoadHandled.add(f);
        f.addEventListener("load", scheduleFramePass);
      }
      attachFrame(f);
    } catch {
      /* iframe hostil: segue o proximo */
    }
  }
}

function scheduleFramePass() {
  if (framePassTimer !== null) return;
  framePassTimer = setTimeout(() => {
    framePassTimer = null;
    framePass();
  }, FRAME_PASS_DELAY_MS);
}

function stopFrameEngines() {
  for (const eng of frameEngines) {
    eng.stopped = true;
    if (eng.observer) {
      try { eng.observer.disconnect(); } catch { /* observer ja morto */ }
      eng.observer = null;
    }
    try {
      if (eng.styleEl) eng.styleEl.remove();
      const marked = eng.doc.querySelectorAll(`[${FRAME_MARK}]`);
      for (const el of marked) el.removeAttribute(FRAME_MARK);
    } catch {
      /* doc ja destruido */
    }
  }
  frameEngines = [];
}

// ---------------------------------------------------------------- estado

// Memoriza a ultima decisao da rede para este host (anti-flash na proxima visita).
let lastCacheJson = "";
function cacheDecision(decision) {
  if (!IS_TOP || !decision || decision.off || decision.mode !== "auto") return;
  const slim = {
    mode: "auto",
    invert: decision.invert,
    engine: decision.engine,
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
// offline, pelos treinadores em tools/ (pipeline nnlab ou GBDT), e chega aqui embutido.
// A temperatura de calibracao vem junto com os pesos (weightsModel.temp).

function loadState() {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (sync) => {
    if (chrome.runtime.lastError) return;
    settings = { ...DEFAULT_SETTINGS, ...sync };
    chrome.storage.local.get("hostCache", (local) => {
      if (chrome.runtime.lastError) return;
      weightsModel = DarlModel.makeModel(globalThis.DARL_PAGE_WEIGHTS);
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
  // v4.3.3: paginas gigantes mutam o tempo todo (React/chats SPA) e a
  // reextracao custa caro (400 getComputedStyle + recalculo de estilo ao
  // desligar/religar os <style> da extensao). O limiar de mutacoes escala
  // com o tamanho do DOM: em 12 mil nos, so reanalisa depois de ~120
  // mutacoes, nao a cada 40. A contagem live (HTMLCollection.length) e
  // barata - sem querySelectorAll.
  const domCount = document.body ? document.body.getElementsByTagName("*").length : 0;
  const minMuts = Math.max(MIN_MUTATIONS, Math.floor(domCount / 100));
  if (mutationCount < minMuts) return;
  const passed = Date.now() - lastExtractAt;
  const wait = passed < RE_ANALYZE_MS ? RE_ANALYZE_MS - passed + 500 : 500;
  reAnalyzeTimer = setTimeout(() => {
    reAnalyzeTimer = null;
    mutationCount = 0;
    if (!document.hidden) extractAndRefresh();
  }, wait);
}

// Pura: alguma mutacao criou iframe? (agendar a passada de frames sem
// esperar a reanalise completa da SPA, que e throttled)
function hasIframeMutation(muts) {
  for (const m of muts) {
    const added = m.addedNodes;
    if (!added || !added.length) continue;
    for (let i = 0; i < added.length; i++) {
      const n = added[i];
      if (!n || n.nodeType !== 1) continue;
      if (n.tagName === "IFRAME") return true;
      if (typeof n.querySelector === "function" && n.querySelector("iframe")) return true;
    }
  }
  return false;
}

function watchMutations() {
  if (!IS_TOP || typeof MutationObserver !== "function") return;
  new MutationObserver((muts) => {
    scheduleReAnalyze();
    if (hasIframeMutation(muts)) scheduleFramePass();
  }).observe(document.documentElement, {
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
  // iframes criados/atualizados ate o load completo: mais uma passada
  // (a descoberta tambem roda no apply e nas mutacoes que criam iframes)
  try {
    window.addEventListener("load", () => scheduleFramePass(), { once: true });
  } catch {
    /* addEventListener indisponivel: as outras descobertas cobrem */
  }
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
