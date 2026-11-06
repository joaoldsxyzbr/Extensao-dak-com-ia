"use strict";

// Extensão Dark com IA - extracao de features da pagina (32 features).
// Modulo compartilhado: e carregado como content script ANTES de content.js
// e tambem e injetado pelo crawler (tools/dev/crawl.js) para montar datasets
// com paginas REAIS. Assim a ordem das features vive num lugar so.
//
// Ordem canonica (identica a tools/train-page-model.js e tools/test-nn.js):
// 0 htmlBg, 1 meanBg | 2-9 histograma de luminancia efetiva (8 faixas)
// 10 fracWithBg, 11 fracDark, 12 fracLight | 13 textLum, 14 lowContrast, 15 contrast
// 16 satMean, 17 satHigh, 18 colorful | 19 imgFrac, 20 bgImgFrac, 21 mono
// 22 fontMean, 23 titleFrac, 24 smallUi, 25 fixedFrac
// 26 articleN, 27 navN, 28 tableN, 29 formN, 30 mediaN, 31 metaDark

(function (global) {
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  const FEATURE_COUNT = 32;

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

  function hasText(el) {
    for (const node of el.childNodes) {
      if (node.nodeType === 3 /* Node.TEXT_NODE */ && node.textContent.trim().length > 0) return true;
    }
    return false;
  }

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

  // Extrai as 32 features da pagina atual.
  // opts.skipStyleIds: ids de <style> da propria extensao que devem ser
  // desligados durante a leitura (a extracao tem que ver a pagina ORIGINAL).
  function extract(opts) {
    const skipIds = new Set((opts && opts.skipStyleIds) || []);
    // Fallback conservador: assume pagina clara enquanto nao ha DOM suficiente.
    const fallback = new Array(FEATURE_COUNT).fill(0);
    fallback[0] = 1;
    fallback[2 + 7] = 0.8; // h7
    fallback[12] = 0.8; // fracLight
    fallback[15] = 0.85; // contrast
    fallback[22] = 0.5; // fontMean

    const extStyles = [];
    try {
      for (const s of document.querySelectorAll("style")) {
        if (skipIds.has(s.id) && !s.disabled) {
          s.disabled = true;
          extStyles.push(s);
        }
      }
    } catch {
      /* DOM imparsavel: extrai como estiver */
    }
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
    } finally {
      for (const s of extStyles) s.disabled = false;
    }
  }

  global.DarlFeatures = {
    FEATURE_COUNT,
    extract,
    lum,
    parseRGB,
    contrastRatio,
    clamp01,
    hasText,
  };
})(globalThis);
