"use strict";

const DEFAULTS = {
  enabled: true,
  invertMedia: true,
  smartImages: true,
  forceTheme: true,
  svgFilter: false,
};

// Chaves de schemas antigos que nao existem mais (v1.0: filtros globais;
// v1.1/v1.2: ajuste manual por site, removido — so a IA decide).
const LEGACY_KEYS = ["siteOverrides", "brightness", "contrast", "sepia", "grayscale", "manualSites"];

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const stored = await chrome.storage.sync.get(null);
    const legacyPresent = LEGACY_KEYS.filter((k) => k in stored);
    if (legacyPresent.length) {
      await chrome.storage.sync.remove(legacyPresent);
    }
    const missing = Object.keys(DEFAULTS).filter((k) => !(k in stored));
    if (missing.length) {
      const patch = {};
      for (const k of missing) patch[k] = DEFAULTS[k];
      await chrome.storage.sync.set(patch);
    }
    // v1-v1.6 treinavam pesos dentro do navegador (nnWeights); a v2 e
    // inference-only: remove pesos treinados obsoletos.
    await chrome.storage.local.remove("nnWeights");
  } catch {
    // instalacao com storage indisponivel: defaults serao usados em memoria
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle") return;
  const stored = await chrome.storage.sync.get(DEFAULTS);
  await chrome.storage.sync.set({ enabled: !stored.enabled });
});
