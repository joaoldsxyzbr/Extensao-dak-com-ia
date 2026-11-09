"use strict";

const DEFAULT_SETTINGS = {
  enabled: true,
  invertMedia: true,
  smartImages: true,
  forceTheme: true,
  svgFilter: false,
  elementMode: true,
};

const $ = (id) => document.getElementById(id);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const pct = (v) => `${Math.round(v * 100)}%`;

let settings;
let host = "";
let themeable = false;
let pageState = null; // resposta do content script da aba ativa

// --------------------------------------------------------------- estado (tab)

async function getPageState(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "darl-get-state" });
    if (response && response.ready) return response;
    if (response) return { ...response, ready: false };
    return null;
  } catch {
    return null; // pagina sem content script (interna ou vazia)
  }
}

// --------------------------------------------------------------- render

function render() {
  $("page-toggle").checked = !!settings.enabled;
  $("host-name").textContent = host || "Página sem endereço";
  $("host-line").style.display = themeable ? "" : "none";

  $("invert-media").checked = settings.invertMedia;
  $("smart-images").checked = settings.smartImages !== false;
  $("force-theme").checked = settings.forceTheme !== false;
  $("svg-filter").checked = settings.svgFilter === true;
  $("element-mode").checked = settings.elementMode !== false;
  $("edge-hint").hidden = !/Edg\//.test(navigator.userAgent);

  const aiAvailable = themeable && pageState && pageState.hasFeatures;
  $("ai-section").style.display = themeable ? "" : "none";

  if (!settings.enabled) {
    setStatus("Extensão desligada. Ligue pelo interruptor do topo.");
  } else if (pageState && pageState.applied && pageState.applied.lock) {
    setStatus("Este site pediu para ficar intacto (meta darkreader-lock) e a IA respeitou.");
  } else if (pageState && pageState.applied && pageState.applied.forced) {
    setStatus("Modo de cores forçadas do sistema ativo: a extensão não interfere.");
  } else if (!aiAvailable) {
    setStatus(pageState === null || !themeable
      ? "Esta página não pode ser analisada."
      : "Analisando página... se travar aqui, recarregue-a ou clique em Reanalisar.");
  } else {
    const applied = pageState.applied;
    if (!applied || applied.off || applied.skip) {
      setStatus("A IA decidiu não alterar nada nesta página.");
      if (applied && typeof applied.invertProb === "number") {
        renderConfidence(applied.invertProb);
      } else {
        $("confidence").textContent = "—";
        $("confidence").className = "pill";
      }
      $("chip-invert").textContent = "Sem inversão";
      $("chip-invert").className = "chip";
      $("chip-brightness").textContent = "—";
      $("chip-contrast").textContent = "—";
      $("chip-sepia").textContent = "—";
      dimChips(["chip-brightness", "chip-contrast", "chip-sepia"]);
    } else {
      if (!applied.invert) {
        setStatus("O site já é escuro: a IA aplicou um retoque para uniformizar (sem inversão).");
        $("chip-invert").textContent = "Retoque escuro";
      } else if (applied.engine === "elements") {
        setStatus("A IA leu as cores de cada elemento e remapeou uma a uma (sem filtro global de inversão).");
        $("chip-invert").textContent = "Por elemento";
      } else {
        setStatus("A mini rede neural leu as cores da página e aplicou este tema:");
        $("chip-invert").textContent = "Inversão ativada";
      }
      renderConfidence(applied.invertProb);
      $("chip-invert").className = "chip on";
      setChip("chip-brightness", `Brilho ${pct(applied.brightness)}`);
      setChip("chip-contrast", `Contraste ${pct(applied.contrast)}`);
      setChip("chip-sepia", `Sépia ${pct(applied.sepia)}`);
    }
  }

}

function setStatus(text) {
  $("ai-status").textContent = text;
}

function renderConfidence(invertProb) {
  const c = invertProb === undefined ? NaN : invertProb;
  if (Number.isNaN(c)) {
    $("confidence").textContent = "—";
    $("confidence").className = "pill";
    return;
  }
  const strong = c > 0.85 || c < 0.15;
  $("confidence").textContent = `confiança ${Math.round(c * 100)}%`;
  $("confidence").className = strong ? "pill good" : "pill warn";
}

function setChip(id, text) {
  $(id).textContent = text;
  $(id).className = "chip on";
  $(id).style.opacity = "";
}

function dimChips(ids) {
  for (const id of ids) $(id).style.opacity = "0.45";
}

// --------------------------------------------------------------- acoes

async function save(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.sync.set(patch);
  render();
}

// --------------------------------------------------------------- eventos

async function init() {
  settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(DEFAULT_SETTINGS)) };

  let url = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id >= 0) {
      if (tab.url) url = new URL(tab.url);
      pageState = await getPageState(tab.id);
    }
  } catch {
    url = null;
    pageState = null;
  }

  const internalSchemes = ["chrome", "edge", "about", "devtools", "view-source", "extension"];
  themeable = Boolean(url && url.hostname && !internalSchemes.includes(url.protocol.slice(0, -1)));
  host = themeable ? url.hostname : "";

  wire();
  render();
}

function wire() {
  $("page-toggle").addEventListener("change", (e) => save({ enabled: e.target.checked }));
  $("invert-media").addEventListener("change", (e) => save({ invertMedia: e.target.checked }));
  $("smart-images").addEventListener("change", (e) => save({ smartImages: e.target.checked }));
  $("force-theme").addEventListener("change", (e) => save({ forceTheme: e.target.checked }));
  $("svg-filter").addEventListener("change", (e) => save({ svgFilter: e.target.checked }));
  $("element-mode").addEventListener("change", (e) => save({ elementMode: e.target.checked }));

  $("export-data").addEventListener("click", async () => {
    const btn = $("export-data");
    btn.disabled = true;
    btn.textContent = "Exportando...";
    try {
      const res = await chrome.runtime.sendMessage({ type: "darl-export-data" });
      btn.textContent = res && res.ok ? `Baixado (${res.count} registros)` : "Nada para exportar ainda";
    } catch {
      btn.textContent = "Falha na exportação";
    }
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = "Exportar dados de navegação";
    }, 2500);
  });

  $("report-problem").addEventListener("click", async () => {
    const btn = $("report-problem");
    btn.disabled = true;
    btn.textContent = "Preparando...";
    try {
      // URL sem query/hash (mesma politica do dataLog: so o necessario
      // para reproduzir o caso, sem vazar nada da navegacao)
      let pageUrl = "";
      let pagePath = "";
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.url) {
          const u = new URL(tab.url);
          pageUrl = u.origin + u.pathname;
          pagePath = u.pathname.slice(0, 120);
        }
      } catch {
        pageUrl = "";
      }
      const applied = pageState && pageState.applied;
      const decision = applied ? {
        engine: applied.engine || null,
        invert: !!applied.invert,
        invertProb: typeof applied.invertProb === "number" ? applied.invertProb : null,
        off: !!applied.off,
        brightness: typeof applied.brightness === "number" ? applied.brightness : null,
        contrast: typeof applied.contrast === "number" ? applied.contrast : null,
        sepia: typeof applied.sepia === "number" ? applied.sepia : null,
        tint: typeof applied.tint === "number" ? applied.tint : null,
      } : null;
      const features = ((pageState && pageState.features) || []).map((v) => Math.round(v * 1000) / 1000);
      const res = await chrome.runtime.sendMessage({
        type: "darl-report-problem",
        report: {
          host,
          path: pagePath,
          url: pageUrl,
          features,
          decision,
          settings: {
            enabled: settings.enabled,
            elementMode: settings.elementMode,
            svgFilter: settings.svgFilter,
            smartImages: settings.smartImages,
            invertMedia: settings.invertMedia,
            forceTheme: settings.forceTheme,
          },
        },
      });
      btn.textContent = res && res.ok ? "Relatório baixado — cole no chat" : "Sem dados desta página";
    } catch {
      btn.textContent = "Falha no relatório";
    }
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = "Reportar problema nesta página";
    }, 3000);
  });

  $("reanalyze").addEventListener("click", async () => {
    let tabId = null;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) tabId = tab.id;
    } catch {
      tabId = null;
    }
    if (tabId === null) return;
    try {
      await chrome.tabs.sendMessage(tabId, { type: "darl-refresh" });
    } catch {
      // content script ausente (pagina interna): nada a fazer
    }
    setTimeout(() => {
      getPageState(tabId).then((state) => {
        pageState = state;
        render();
      });
    }, 200);
  });


  $("reset").addEventListener("click", async () => {
    await chrome.storage.sync.set(DEFAULT_SETTINGS);
    settings = { ...DEFAULT_SETTINGS };
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) pageState = await getPageState(tab.id);
    render();
  });
}

document.addEventListener("DOMContentLoaded", init);
