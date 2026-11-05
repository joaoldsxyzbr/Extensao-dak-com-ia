"use strict";

const DEFAULT_SETTINGS = {
  enabled: true,
  invertMedia: true,
  smartImages: true,
  forceTheme: true,
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

async function loadWeightsEnvelope() {
  const stored = await chrome.storage.local.get("nnWeights");
  const w = stored.nnWeights && stored.nnWeights.w;
  // so usa pesos treinados pelo feedback se forem compativeis com esta versao do modelo
  if (DarlNN.compatible(w, DARL_PAGE_WEIGHTS.dims)) return stored.nnWeights;
  return { w: DARL_PAGE_WEIGHTS, v: 0 };
}

// --------------------------------------------------------------- render

function render() {
  $("page-toggle").checked = !!settings.enabled;
  $("host-name").textContent = host || "Página sem endereço";
  $("host-line").style.display = themeable ? "" : "none";

  $("invert-media").checked = settings.invertMedia;
  $("smart-images").checked = settings.smartImages !== false;
  $("force-theme").checked = settings.forceTheme !== false;

  const aiAvailable = themeable && pageState && pageState.hasFeatures;
  $("ai-section").style.display = themeable ? "" : "none";

  if (!settings.enabled) {
    setStatus("Extensão desligada. Ligue pelo interruptor do topo.");
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

  const fbEnabled = aiAvailable && settings.enabled &&
    pageState.applied && !pageState.applied.off && !pageState.applied.skip;
  $("feedback").style.display = fbEnabled ? "" : "none";
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

// Feedback: treina a rede localmente com backprop e propaga para todas as abas.
// O ajuste vai na saida que controla o brilho visivel do ramo atual:
//   pagina invertida -> saida "brilho" | retoque escuro -> saida "dim".
async function sendFeedback(direction) {
  if (!pageState || !pageState.features) return;
  const envelope = await loadWeightsEnvelope();
  const model = DarlNN.makeNet(envelope.w.dims, envelope.w);
  const { p } = DarlNN.forward(model, pageState.features);

  const target = p.slice();
  const applied = pageState.applied;
  if (applied && applied.invert) {
    const moved = (0.6 + 0.8 * p[1]) + (direction === "darker" ? -0.15 : 0.15);
    target[1] = clamp01((moved - 0.6) / 0.8);
  } else {
    const moved = (0.7 + 0.3 * p[4]) + (direction === "darker" ? -0.05 : 0.05);
    target[4] = clamp01((moved - 0.7) / 0.3);
  }

  for (let i = 0; i < 30; i++) DarlNN.train(model, pageState.features, target, 0.1);

  await chrome.storage.local.set({
    nnWeights: { w: DarlNN.serialize(model), v: (envelope.v || 0) + 1 },
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) pageState = await getPageState(tab.id);
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

  $("fb-light").addEventListener("click", () => sendFeedback("darker"));
  $("fb-dark").addEventListener("click", () => sendFeedback("lighter"));

  $("reset").addEventListener("click", async () => {
    await chrome.storage.sync.set(DEFAULT_SETTINGS);
    await chrome.storage.local.remove("nnWeights"); // volta aos pesos treinados originais
    settings = { ...DEFAULT_SETTINGS };
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) pageState = await getPageState(tab.id);
    render();
  });
}

document.addEventListener("DOMContentLoaded", init);
