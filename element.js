"use strict";

// Extensão Dark com IA - motor de analise por elemento (v4).
//
// Nas decisisoes de "inverter", em vez de aplicar um filtro global de
// inversao na pagina inteira, este motor le o estilo computado de CADA
// elemento e remapeia cor por cor (fundos claros -> escuros mantendo o
// matiz, textos escuros -> claros, bordas, sombras e gradientes junto).
// E a abordagem que o Dark Reader usa: paginas hibridas ficam certas
// porque cada regiao e tratada de acordo com a propria cor original.
//
// O motor e incremental: elementos novos (SPAs) sao processados em lotes
// via requestIdleCallback, com teto de elementos e fallback automatico
// para o modo filtro classico quando a pagina e grande demais ou algo
// falha. As funcoes de mapeamento de cor sao puras (testadas em
// tools/test-nn.js sem DOM).

(function (global) {
  const STYLE_ID = "darl-element-style";
  const MARK_ATTR = "darl-el";
  const GUARD_ATTR = "darl-guard"; // elemento ja coberto pela guarda de interacao
  const MAX_ELEMENTS = 30000; // acima disso: fallback para modo filtro (v4.3.2: a visao de conversa do Rocket.Chat passa de 8000 e ficava meio remapeada - o pior estado possivel)
  const BATCH = 120;
  const FLUSH_MS = 400; // intervalo minimo entre flushes de regras (v4.3.3: cada flush no <style> custa um recalculo de estilo da pagina inteira - em SPAs gigantes nao pode ser a cada lote)
  const GUARD_RECHECK_MS = 1500; // recheck da guarda de interacao por elemento (v4.3.3: mousemove nao pode custar getComputedStyle a cada evento)

  // Tipos que nunca precisam de regra de cor.
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "LINK", "META", "TITLE", "HEAD", "NOSCRIPT", "TEMPLATE", "BASE", "BR", "WBR",
  ]);
  // Elementos cujo texto (value/placeholder) nao vive em nos de texto.
  const TEXTISH = new Set(["INPUT", "TEXTAREA", "SELECT", "OPTION", "BUTTON", "A", "LABEL", "SUMMARY"]);

  // ------------------------------------------------------------ cores puras

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    let h = 0;
    const l = (mx + mn) / 2;
    const d = mx - mn;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (d !== 0) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s: Math.min(1, s), l };
  }

  function hslToCss(h, s, l, a) {
    const f = (n) => {
      const k = (n + h / 30) % 12;
      const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
      return Math.round(255 * c);
    };
    const alpha = a === undefined ? "" : `, ${Math.round(a * 100) / 100}`;
    return `rgb${alpha ? "a" : ""}(${f(0)}, ${f(8)}, ${f(4)}${alpha})`;
  }

  const lum255 = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

  function contrastRatio(l1, l2) {
    const hi = Math.max(l1, l2) + 0.05;
    const lo = Math.min(l1, l2) + 0.05;
    return hi / lo;
  }

  const BG_LIGHT = 0.28; // acima disso, fundo escurece
  const TEXT_DARK = 0.50; // abaixo disso, texto clareia
  const CANVAS_L = 0.12; // luminancia do canvas mapeado (html padrao)

  // Acentos pequenos e saturados (v4.3.2): a bolinha verde de presenca, o
  // badge de nao lidas etc. sao SINAIS - a cor viva e o significado. O
  // remapeamento normal os trataria como "fundo claro" e viraria um verde
  // apagado. Regra: elemento minusculo com cor clara e saturada mantem a
  // cor original (a pagina invertida e escura: o acento destaca sozinho).
  const ACCENT_SAT = 0.30; // saturacao minima de um acento vivo
  const ACCENT_MAX_PX = 14; // maior lado (px) que ainda conta como dot/badge

  function saturation255(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return mx === 0 ? 0 : (mx - mn) / mx;
  }

  // Pura: cor clara e saturada = acento candidato (verde de presenca, laranja
  // de badge). Cinza claro nao e acento (e so um fundo pequeno).
  function isAccentColor(c) {
    return Boolean(c) && c.a > 0.04 &&
      saturation255(c.r, c.g, c.b) >= ACCENT_SAT &&
      lum255(c.r, c.g, c.b) >= BG_LIGHT;
  }

  // Pura: so elementos minusculos (dot/badge) podem manter a cor viva.
  function isAccentSize(w, h) {
    return w > 0 && h > 0 && Math.max(w, h) <= ACCENT_MAX_PX;
  }

  // Mede o elemento na tela: so chama depois de isAccentColor passar
  // (getBoundingClientRect forca layout; nao pode custar em todo scan).
  function isAccentRect(el) {
    try {
      const rect = el.getBoundingClientRect();
      return isAccentSize(rect.width, rect.height);
    } catch {
      return false;
    }
  }

  // Fundo claro -> escuro mantendo matiz (branco -> ~#202020, nao #000).
  function mapBackground(c) {
    const l = lum255(c.r, c.g, c.b);
    const hsl = rgbToHsl(c.r, c.g, c.b);
    const nl = Math.min(0.16, 0.055 + 0.07 * l);
    const ns = Math.min(1, hsl.s * (l > 0.8 ? 0.85 : 0.95));
    return { css: hslToCss(hsl.h, ns, nl, c.a < 1 ? c.a : undefined), lum: nl, origLum: l };
  }

  // Texto escuro -> claro mantendo o matiz (links azuis continuam azuis).
  function mapText(c, bgLum) {
    const l = lum255(c.r, c.g, c.b);
    const hsl = rgbToHsl(c.r, c.g, c.b);
    let nl = Math.min(0.96, 0.80 + 0.16 * l);
    // Guarda WCAG: contraste minimo 4.5:1 contra o fundo mapeado.
    let guard = 0;
    while (nl < 0.97 && contrastRatio(nl, bgLum === undefined ? CANVAS_L : bgLum) < 4.5 && guard++ < 20) {
      nl = Math.min(0.97, nl + 0.03);
    }
    return { css: hslToCss(hsl.h, Math.min(1, hsl.s * 0.95), nl, c.a < 1 ? c.a : undefined), lum: nl, origLum: l };
  }

  // Cor intermediaria usada em bordas/sombras/gradientes.
  function mapNeutral(c, bgLum) {
    const l = lum255(c.r, c.g, c.b);
    if (l >= 0.5) {
      const m = mapBackground(c);
      // bordas um pouco mais claras que o fundo para continuarem visiveis
      return { css: hslToCss(rgbToHsl(c.r, c.g, c.b).h, 0.9 * rgbToHsl(c.r, c.g, c.b).s, Math.min(0.20, m.lum + 0.035), c.a < 1 ? c.a : undefined), lum: m.lum + 0.035 };
    }
    if (l >= 0.2) {
      const t = mapText(c, bgLum);
      return { css: t.css, lum: t.lum * 0.85 }; // acentos escuros ficam discretos
    }
    return { css: null, lum: l }; // cor ja escura: deixa como esta
  }

  const COLOR_RE = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/g;

  function parseColorList(str) {
    const out = [];
    COLOR_RE.lastIndex = 0;
    let m;
    while ((m = COLOR_RE.exec(str))) {
      out.push({ r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]), a: m[4] === undefined ? 1 : parseFloat(m[4]) });
    }
    return out;
  }

  // Remapeia todas as cores de um background-image de gradiente computado.
  function remapGradient(bgImage) {
    const colors = parseColorList(bgImage);
    if (!colors.length) return null;
    let changed = false;
    let out = bgImage;
    let i = 0;
    COLOR_RE.lastIndex = 0;
    out = bgImage.replace(COLOR_RE, (whole) => {
      const c = colors[i++];
      if (!c) return whole;
      const l = lum255(c.r, c.g, c.b);
      const mapped = l >= 0.5 ? mapBackground(c) : l >= 0.2 ? mapNeutral(c) : null;
      if (!mapped || !mapped.css) return whole;
      changed = true;
      return mapped.css;
    });
    return changed ? out : null;
  }

  function remapShadow(shadow, bgLum) {
    const colors = parseColorList(shadow);
    if (!colors.length) return null;
    let changed = false;
    let i = 0;
    const out = shadow.replace(COLOR_RE, (whole) => {
      const c = colors[i++];
      if (!c) return whole;
      const l = lum255(c.r, c.g, c.b);
      const mapped = l >= 0.5 ? mapBackground(c) : null; // sombra clara -> escura
      if (!mapped || !mapped.css) return whole;
      changed = true;
      return mapped.css;
    });
    return changed ? out : null;
  }

  // ---------------------------------------------------------------- estado

  let active = false;
  let styleEl = null;
  let ruleBuffer = []; // regras prontas esperando o proximo flush (v4.3.3)
  let lastFlushAt = 0;
  let guardChecked = null; // WeakMap el -> ts do ultimo check da guarda (v4.3.3)
  let markId = 0;
  let guardId = 0;
  let guardListeners = null;
  let observer = null;
  let scanScheduled = false;
  let scanning = false;
  let queue = [];
  let firstChunkDone = false;
  let onFirstChunk = null;
  let onFallback = null;

  function ensureStyle() {
    if (styleEl) return styleEl;
    styleEl = document.createElement("style");
    styleEl.id = STYLE_ID;
    document.documentElement.appendChild(styleEl);
    styleEl.textContent = `
html { background-color: #17181d !important; color-scheme: dark !important; }
/* icones/logos escuros: a rede de imagens os marca e aqui eles viram claros */
img.dd-keep { filter: invert(1) hue-rotate(180deg) brightness(1.15) !important; }
@media print { [${MARK_ATTR}], [${GUARD_ATTR}] { background-color: revert !important; color: revert !important; border-color: revert !important; } html { background-color: revert !important; } }`;
    ruleBuffer = [];
    lastFlushAt = 0;
    return styleEl;
  }

  // Flush incremental (v4.3.2): so o delta de regras entra no DOM - nunca o
  // <style> inteiro. Throttle (v4.3.3): em paginas gigantes cada flush custa
  // um recalculo de estilo completo; as regras de um lote acumulam no buffer
  // e entram juntas no proximo intervalo. force=true furia o intervalo
  // (primeiro lote, fim da varredura, guarda de interacao).
  function flushStyle(force) {
    if (!styleEl || !ruleBuffer.length) return;
    if (!force) {
      const now = Date.now();
      if (now - lastFlushAt < FLUSH_MS) return;
    }
    styleEl.appendChild(document.createTextNode("\n" + ruleBuffer.join("\n")));
    ruleBuffer = [];
    lastFlushAt = Date.now();
  }

  // ------------------------------------------------------------ varredura

  function elementRule(el, id, bgLumDefault) {
    const cs = getComputedStyle(el);
    const parts = [];

    const bg = DarlFeatures.parseRGB(cs.backgroundColor);
    const fg = DarlFeatures.parseRGB(cs.color);
    const needsText = el.childNodes && Array.prototype.some.call(el.childNodes, (n) => n.nodeType === 3 && n.textContent.trim()) || TEXTISH.has(el.tagName);
    const fgDark = Boolean(fg) && needsText && lum255(fg.r, fg.g, fg.b) <= TEXT_DARK;

    let bgLum = bgLumDefault;
    if (bg && bg.a > 0.04) {
      const bl = lum255(bg.r, bg.g, bg.b);
      if (bl >= BG_LIGHT) {
        // Acento vivo (bolinha de presenca, badge): minusculo + saturado sem
        // texto escuro proprio -> mantem a cor ORIGINAL. O resto escurece.
        if (!fgDark && isAccentColor(bg) && isAccentRect(el)) {
          bgLum = bl; // a cor viva ficou: textos herdeiros medem contra ela
        } else {
          const m = mapBackground(bg);
          parts.push(`background-color: ${m.css} !important`);
          bgLum = m.lum;
        }
      } else if (bg.a >= 0.98) {
        bgLum = bl; // fundo ja escuro: textos devem se medir contra ele
      }
    }

    if (fg && needsText) {
      const fl = lum255(fg.r, fg.g, fg.b);
      if (fl <= TEXT_DARK) {
        const m = mapText(fg, bgLum);
        parts.push(`color: ${m.css} !important`);
      }
    }

    const borders = ["borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor"];
    const borderSeen = new Set();
    for (const b of borders) {
      const bc = DarlFeatures.parseRGB(cs[b]);
      if (!bc) continue;
      const key = bc.r + "," + bc.g + "," + bc.b + "," + bc.a;
      if (borderSeen.has(key)) continue;
      borderSeen.add(key);
      const bl = lum255(bc.r, bc.g, bc.b);
      if (bl >= 0.30) {
        const m = mapNeutral(bc, bgLum);
        if (m.css) parts.push(`${b.replace(/[A-Z]/g, (ch) => "-" + ch.toLowerCase())}: ${m.css} !important`);
      }
    }

    const bi = cs.backgroundImage;
    if (typeof bi === "string" && bi.includes("gradient(")) {
      const g = remapGradient(bi);
      if (g) parts.push(`background-image: ${g} !important`);
    }

    const sh = cs.boxShadow;
    if (typeof sh === "string" && sh && sh !== "none") {
      const s = remapShadow(sh, bgLum);
      if (s) parts.push(`box-shadow: ${s} !important`);
    }

    const fill = DarlFeatures.parseRGB(cs.fill);
    if (fill && lum255(fill.r, fill.g, fill.b) <= TEXT_DARK && fill.a > 0.04) {
      const m = mapText(fill, bgLum);
      parts.push(`fill: ${m.css} !important`);
    }
    const stroke = DarlFeatures.parseRGB(cs.stroke);
    if (stroke && lum255(stroke.r, stroke.g, stroke.b) <= TEXT_DARK && stroke.a > 0.04) {
      const m = mapText(stroke, bgLum);
      parts.push(`stroke: ${m.css} !important`);
    }

    if (!parts.length) return "";
    el.setAttribute(MARK_ATTR, String(id));
    return `[${MARK_ATTR}="${id}"] { ${parts.join("; ")}; }`;
  }

  function scanBatch() {
    if (!active || !queue.length) { scanning = false; scanScheduled = false; return; }
    const t0 = Date.now();
    let rules = [];
    while (queue.length && Date.now() - t0 < 24) {
      const el = queue.shift();
      if (!el.isConnected) continue;
      if (el.hasAttribute(MARK_ATTR)) continue;
      if (!isQueueableNode(el)) continue;
      try {
        const rule = elementRule(el, ++markId, CANVAS_L);
        if (rule) rules.push(rule);
        else el.setAttribute(MARK_ATTR, String(++markId)); // marca mesmo sem regra (scan incremental)
      } catch {
        /* estilo imparsavel: segue o proximo */
      }
      if (markId > MAX_ELEMENTS) break;
    }
    if (rules.length) {
      ruleBuffer.push(...rules);
      flushStyle(false); // throttled: acumula ate o proximo intervalo
    }
    if (!firstChunkDone) {
      firstChunkDone = true;
      flushStyle(true); // o reveal acontece agora: as regras do 1o lote precisam estar no DOM
      if (typeof onFirstChunk === "function") { try { onFirstChunk(); } catch { /* reveal e best-effort */ } }
    }
    if (queue.length && markId <= MAX_ELEMENTS) {
      const step = () => scanBatch();
      if (global.requestIdleCallback) requestIdleCallback(step, { timeout: 400 });
      else setTimeout(step, 16);
    } else {
      scanning = false;
      scanScheduled = false;
      flushStyle(true); // varredura acabou: entrega o que sobrou no buffer
      if (markId > MAX_ELEMENTS && typeof onFallback === "function") {
        const cb = onFallback; onFallback = null;
        try { cb(); } catch { /* fallback e best-effort */ }
      }
    }
  }

  // Pura: pode entrar na fila da varredura? (nó de elemento, sem tags
  // inuteis, sem os estilos da propria extensao) - testavel sem DOM.
  function isQueueableNode(node) {
    if (!node || node.nodeType !== 1) return false;
    if (SKIP_TAGS.has(node.tagName)) return false;
    return node.id !== STYLE_ID && node.id !== "darl-dark-style" &&
      node.id !== "darl-flash-cover" && node.id !== "darl-svg-host";
  }

  // Agenda um scan se nenhum estiver rodando (a cadeia de lotes em idle
  // drena a fila sozinha quando ja esta ativa).
  function scheduleScan() {
    if (!active || scanning || scanScheduled) return;
    scanning = true;
    scanScheduled = true;
    const step = () => scanBatch();
    if (global.requestIdleCallback) requestIdleCallback(step, { timeout: 400 });
    else setTimeout(step, 16);
  }

  // Varredura inicial: pagina inteira uma vez so (a partir dai o observer
  // alimenta a fila so com o que nasceu novo - v4.3.3).
  function startScan() {
    const root = [];
    if (document.documentElement) root.push(document.documentElement);
    if (document.body) root.push(document.body);
    if (document.body) root.push(...document.body.querySelectorAll("*"));
    queue = queue.concat(root.filter((el) => !el.hasAttribute(MARK_ATTR)));
    scheduleScan();
  }

  // Fila guiada por mutacoes (v4.3.3): o SPA insere subarvores inteiras de
  // uma vez (React) - andar os descendentes aqui e O(novos), em vez de
  // reconsultar a pagina TODA a cada 1.5s (o Rocket.Chat muta sem parar e
  // a reconsulta cheia de 20 mil nos era o principal gargalo de CPU).
  function queueMutations(muts) {
    let fresh = false;
    for (const m of muts) {
      const added = m.addedNodes;
      if (!added || !added.length) continue;
      for (let i = 0; i < added.length; i++) {
        const n = added[i];
        if (!isQueueableNode(n)) continue;
        queue.push(n);
        fresh = true;
        if (n.querySelectorAll) {
          for (const c of n.querySelectorAll("*")) {
            if (isQueueableNode(c)) queue.push(c);
          }
        }
      }
    }
    if (fresh) scheduleScan();
  }

  // --------------------------------------------------- guarda de interacao
  //
  // Regras de interacao (:hover, :focus, :active) e overlays em
  // pseudo-elementos (::before/::after) NAO existem no estilo computado
  // em repouso: a varredura estatica nao os ve. O tema claro original
  // costuma ter "hover branco" - elemento transparente em repouso ganha
  // fundo claro com o mouse em cima, e o texto (claro, remanejado ou nao)
  // fica ilegivel. A guarda observa mouseover/focusin em tempo real:
  // quando um elemento ESTA claro naquele instante, o remapeamento e
  // congelado numa regra permanente do elemento. Cobre tambem cores via
  // var() e estilos inline trocados por JS - o valor LIDO ja resolvido.

  // Pura: dado o estado computado AGORA (com hover/foco ativo), devolve
  // as declaracoes que congelam o remapeamento escuro. Testavel sem DOM.
  // keepBg (v4.3.2): acento vivo identificado pelo chamador - o fundo fica.
  function guardDecls(bg, bgImage, fg, keepBg) {
    const out = [];
    if (!keepBg && bg && bg.a > 0.04 && lum255(bg.r, bg.g, bg.b) >= BG_LIGHT) {
      out.push(`background-color: ${mapBackground(bg).css} !important`);
    }
    if (typeof bgImage === "string" && bgImage.includes("gradient(")) {
      const g = remapGradient(bgImage);
      if (g) out.push(`background-image: ${g} !important`);
    }
    if (fg && fg.a > 0.04 && lum255(fg.r, fg.g, fg.b) <= TEXT_DARK) {
      out.push(`color: ${mapText(fg, CANVAS_L).css} !important`);
    }
    return out;
  }

  function guardInteraction(el) {
    if (!el || el.nodeType !== 1) return;
    if (SKIP_TAGS.has(el.tagName) || el.id === STYLE_ID || el.id === "darl-dark-style" || el.id === "darl-flash-cover" || el.id === "darl-svg-host") return;
    if (el.hasAttribute(GUARD_ATTR)) return; // ja coberto
    // Throttle por elemento (v4.3.3): mousemove dispara dezenas de eventos
    // por segundo no mesmo elemento; getComputedStyle nele e nos
    // pseudo-elementos nao pode rodar em cada evento.
    if (guardChecked) {
      const lastAt = guardChecked.get(el);
      if (lastAt !== undefined && Date.now() - lastAt < GUARD_RECHECK_MS) return;
    }
    let decls = [], before = [], after = [];
    let keepBg = false;
    try {
      const cs = getComputedStyle(el);
      const bgNow = DarlFeatures.parseRGB(cs.backgroundColor);
      const fgNow = DarlFeatures.parseRGB(cs.color);
      // Acento vivo (v4.3.2): hover sobre a bolinha de presenca nao pode
      // congelar um fundo escurecido nela - a cor original e o sinal.
      const fgDarkNow = Boolean(fgNow) && lum255(fgNow.r, fgNow.g, fgNow.b) <= TEXT_DARK;
      keepBg = !fgDarkNow && isAccentColor(bgNow) && isAccentRect(el);
      decls = guardDecls(bgNow, cs.backgroundImage, fgNow, keepBg);
      const pb = getComputedStyle(el, "::before");
      before = guardDecls(DarlFeatures.parseRGB(pb.backgroundColor), pb.backgroundImage, null);
      const pa = getComputedStyle(el, "::after");
      after = guardDecls(DarlFeatures.parseRGB(pa.backgroundColor), pa.backgroundImage, null);
    } catch {
      return; // estilo imparsavel: nao congela nada
    }
    if (guardChecked) guardChecked.set(el, Date.now()); // contou pro throttle
    if (!decls.length && !before.length && !after.length) return;
    const id = String(++guardId);
    try { el.setAttribute(GUARD_ATTR, id); } catch { return; }
    const base = `[${GUARD_ATTR}="${id}"]`;
    let text = "";
    if (decls.length) text += `\n${base} { ${decls.join("; ")}; }`;
    if (before.length) text += `\n${base}::before { ${before.join("; ")}; }`;
    if (after.length) text += `\n${base}::after { ${after.join("; ")}; }`;
    ruleBuffer.push(text.replace(/^\n/, ""));
    flushStyle(true); // hover precisa de efeito imediato: fura o throttle
  }

  // mouseover/focusin delegados: cobre o alvo e os ancestrais proximos
  // (regra tipo "li:hover" estiliza o LI, mas o evento nasce num filho).
  function onPointerEvent(evt) {
    if (!active) return;
    let el = evt.target;
    for (let i = 0; el && el.nodeType === 1 && i < 5; i++, el = el.parentElement) {
      guardInteraction(el);
    }
  }

  // ------------------------------------------------------------- API global

  function start(decision, hooks) {
    if (typeof document === "undefined" || !document.documentElement) return false;
    active = true;
    firstChunkDone = false;
    if (typeof WeakMap === "function") guardChecked = new WeakMap();
    onFirstChunk = (hooks && hooks.onApplied) || null;
    onFallback = (hooks && hooks.onFallback) || null;
    ensureStyle();
    startScan();
    if (typeof MutationObserver === "function") {
      observer = new MutationObserver(queueMutations);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    // guarda de interacao: hover/foco em tempo real (capture para nao
    // depender do site parar a propagacao)
    if (typeof document.addEventListener === "function") {
      guardListeners = [["mouseover", onPointerEvent], ["focusin", onPointerEvent]];
      for (const [ev, fn] of guardListeners) document.addEventListener(ev, fn, { capture: true, passive: true });
    }
    return true;
  }

  function stop() {
    active = false;
    if (observer) { observer.disconnect(); observer = null; }
    if (guardListeners) {
      for (const [ev, fn] of guardListeners) document.removeEventListener(ev, fn, { capture: true });
      guardListeners = null;
    }
    queue = [];
    scanning = false;
    scanScheduled = false;
    ruleBuffer = [];
    lastFlushAt = 0;
    onFirstChunk = null;
    onFallback = null;
    if (styleEl) { styleEl.remove(); styleEl = null; }
    markId = 0;
    guardId = 0;
    try {
      const marked = document.querySelectorAll(`[${MARK_ATTR}], [${GUARD_ATTR}]`);
      for (const el of marked) { el.removeAttribute(MARK_ATTR); el.removeAttribute(GUARD_ATTR); }
    } catch {
      /* DOM ja destruido */ }
  }

  // Pura (v4.3.4): URL de documento de frame que o MV3 NAO injeta com
  // content script (about:blank e about:srcdoc). Esses frames (editores
  // embutidos, viewers de preview, caixas de texto rica) ficariam paineis
  // brancos no meio do tema escuro: quem remapeia por eles e o documento
  // TOP, que alcança o contentDocument de frames de mesma origem.
  function isUnscriptedFrameURL(url) {
    return typeof url === "string" && (url === "about:blank" || url === "about:srcdoc");
  }

  // Pura (v4.3.4): deteccao DECLARATIVA de iframe sem content script. O
  // doc.URL de um frame about:blank HERDA a URL do pai no Chrome (heranca
  // de URL da spec), entao conferir doc.URL nunca identifica o frame —
  // foi exatamente o bug do CI. Os sinais confiaveis sao os ATRIBUTOS:
  // o MV3 injeta content script apenas em frames navegados por http(s)/
  // ws/fp etc. (match patterns); qualquer frame cujo alvo declarativo e
  // srcdoc, sem src, src vazio, about:blank, javascript:, data: ou blob:
  // NAO recebe script — e quem remapeia por ele e o documento topo.
  // Navegacao http(s) sempre deixa src nao-vazio (inclusive via
  // iframe.src = "...", que reflete no atributo), entao nao ha falso
  // positivo de frame http tratado como sem-script.
  function isUnscriptedFrameAttrs(srcAttr, hasSrcdoc) {
    if (hasSrcdoc === true) return true;
    const s = typeof srcAttr === "string" ? srcAttr.trim().toLowerCase() : "";
    if (!s) return true; // sem src: about:blank sincrono (editores, previews)
    return (
      s === "about:blank" ||
      s === "about:srcdoc" ||
      s.startsWith("javascript:") ||
      s.startsWith("data:") ||
      s.startsWith("blob:")
    );
  }

  const api = {
    start, stop,
    isActive: () => active,
    // funcoes puras expostas para os testes (tools/test-nn.js)
    mapBackground, mapText, mapNeutral, remapGradient, remapShadow,
    rgbToHsl, lum255: (r, g, b) => lum255(r, g, b), guardDecls,
    parseColorList, isAccentColor, isAccentSize, saturation255,
    isQueueableNode, isUnscriptedFrameURL, isUnscriptedFrameAttrs,
    ACCENT_SAT, ACCENT_MAX_PX, FLUSH_MS, GUARD_RECHECK_MS,
    STYLE_ID, MARK_ATTR, GUARD_ATTR, MAX_ELEMENTS,
    _internals: { BG_LIGHT, TEXT_DARK, CANVAS_L, contrastRatio, elementRule, guardInteraction },
  };

  global.DarlElement = api;
})(globalThis);
