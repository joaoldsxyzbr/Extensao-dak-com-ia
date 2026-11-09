"use strict";

const DEFAULTS = {
  enabled: true,
  invertMedia: true,
  smartImages: true,
  forceTheme: true,
  svgFilter: false,
  elementMode: true,
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

// Exportacao dos dados de navegacao (features + decisoes da IA): o usuario
// baixa um JSON local com o que a extensao viu - materia-prima para o
// retreino com dados reais. Nada sai da maquina sem esse clique.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return undefined;

  if (msg.type === "darl-export-data") {
    (async () => {
      try {
        const res = await chrome.storage.local.get({ dataLog: [] });
        const records = Array.isArray(res.dataLog) ? res.dataLog : [];
        const payload = {
          exportedAt: new Date().toISOString(),
          note: "Extensao Dark com IA - analises reais de navegacao (host, features, decisao). Retreino: tools/.",
          records,
        };
        const json = JSON.stringify(payload, null, 2);
        // btoa nao aceita unicode direto: codifica os bytes em pedacos
        // (spread de array grande estoura a pilha).
        const bytes = new TextEncoder().encode(json);
        let bin = "";
        for (let i = 0; i < bytes.length; i += 8192) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        const b64 = btoa(bin);
        const url = "data:application/json;base64," + b64;
        await chrome.downloads.download({ url, filename: "darl-dados-navegacao.json", saveAs: true });
        sendResponse({ ok: true, count: records.length });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true; // resposta assincrona
  }

  // Report de problema (v4.3.4): o popup junta host + as 32 features +
  // decisao da IA + configuracao da pagina ativa e o usuario baixa um JSON
  // unico, pronto para colar no chat do mantenedor - diagnostico em um
  // clique, sem exportar o dataLog inteiro. Continua 100% local e opt-in.
  if (msg.type === "darl-report-problem") {
    (async () => {
      try {
        const r = msg.report || {};
        const payload = {
          exportedAt: new Date().toISOString(),
          note: "Extensao Dark com IA - report de problema. Cole o conteudo deste arquivo no chat: host + 32 features + decisao da IA + configuracao, prontos para diagnostico (arquetipo, fixture e retreino).",
          extVersion: chrome.runtime.getManifest().version,
          host: typeof r.host === "string" ? r.host : null,
          url: typeof r.url === "string" ? r.url : null,
          settings: r.settings || null,
          decision: r.decision || null,
          features: Array.isArray(r.features) ? r.features : null,
        };
        const json = JSON.stringify(payload, null, 2);
        const bytes = new TextEncoder().encode(json);
        let bin = "";
        for (let i = 0; i < bytes.length; i += 8192) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        const url = "data:application/json;base64," + btoa(bin);
        const safeHost = String(r.host || "pagina").replace(/[^a-z0-9.-]/gi, "-");
        await chrome.downloads.download({ url, filename: `darl-report-${safeHost}.json`, saveAs: true });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true; // resposta assincrona
  }

  return undefined;
});
