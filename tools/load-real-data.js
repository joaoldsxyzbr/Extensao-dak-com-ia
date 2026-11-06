// Carregador de dados reais para o treino do modelo de paginas (Extensão
// Dark com IA v4.3). Le os datasets coletados pelo crawler (tools/dev/data/
// report-*.json, commitados de volta pelo job crawl-real do CI) e rotula
// cada pagina pela APARENCIA ORIGINAL (screenshot "antes" + metricas
// perceptuais) — auto-labeling: ninguem precisa rotular a mao.
//
// Regra de rotulagem (conservadora de proposito):
//   - claro (meanLum alto, pouco escuro)  -> inverter (familia LIGHT)
//   - escuro (meanLum baixo, muito escuro) -> retoque (familia DARK)
//   - hibrido de APARENCIA (screenshot na zona cinza: hero colorido, muitas
//     midias) -> desambiguado pelo CONTEUDO (v4.3.1): features por elemento
//     dizem a verdade que a media de pixels nao diz —
//       elementos claros + texto escuro  -> claro (inverte; imagens ficam)
//       elementos escuros + texto claro  -> escuro (nao mexe)
//   - ainda ambiguo, OU pagina em branco (lumStd baixo = erro de carga,
//     paywall, bloqueio de bot) -> DESCARTADO: rotulo sem confianca nao
//     entra no treino.
//
// Uso: node -e "console.log(require('./tools/load-real-data.js').stats())"
// O treinador (train-page-gbdt.js) soma os registros ao treino com peso.
"use strict";

const fs = require("fs");
const path = require("path");

const IN = 32;

// Familias de rotulo: mesmos valores dos arquétipos LIGHT_WEB / DARK.
const Y_LIGHT = [1, 0.42, 0.40, 0.06, 0.5, 0.12];
const Y_DARK = [0, 0.5, 0.2, 0.02, 0.45, 0.04];

// Limiares perceptuais (mesma fisica das FIXTURE_RULES do crawler).
const BLANK_LUMSTD = 0.02; // pagina plana demais = erro de carga/blank
const LIGHT_MEANLUM = 0.5;
const LIGHT_DARKFRAC = 0.35;
const DARK_MEANLUM = 0.25;
const DARK_DARKFRAC = 0.55;

// Desambiguacao dos hibridos de aparencia pelo conteudo (v4.3.1). A media
// de pixels mente sobre paginas claras cheias de imagens/hero colorido; a
// leitura por elemento nao. Indices = ordem canonica (page-dataset.js ORDER2).
const F_FRAC_DARK = 11;
const F_FRAC_LIGHT = 12;
const F_TEXT_LUM = 13;
const HYBRID_LIGHT_FRACLIGHT = 0.85; // quase todos os elementos claros...
const HYBRID_LIGHT_TEXTLUM = 0.5; // ...com texto escuro = conteudo claro
const HYBRID_DARK_FRACDARK = 0.85; // quase todos os elementos escuros...
const HYBRID_DARK_TEXTLUM = 0.6; // ...com texto claro = conteudo escuro

// Pura: dado um registro do report.json, devolve {label, y} ou null se o
// rotulo nao e confiavel. Testavel sem filesystem.
function labelEntry(entry) {
  if (!entry || entry.error) return null;
  if (!Array.isArray(entry.features) || entry.features.length !== IN) return null;
  const a = entry.antes;
  if (!a || typeof a.meanLum !== "number" || typeof a.darkFrac !== "number" || typeof a.lumStd !== "number") return null;
  if (a.lumStd < BLANK_LUMSTD) return null; // blank/erro: sem rotulo
  if (a.meanLum > LIGHT_MEANLUM && a.darkFrac < LIGHT_DARKFRAC) {
    return { label: "light", y: Y_LIGHT.slice() };
  }
  if (a.meanLum < DARK_MEANLUM && a.darkFrac > DARK_DARKFRAC) {
    return { label: "dark", y: Y_DARK.slice() };
  }
  // Hibrido de APARENCIA: screenshot na zona cinza, mas o CONTEUDO (features
  // por elemento) diz a verdade — o hero colorido/midias arrastam o meanLum,
  // o elemento nao mente (v4.3.1).
  const f = entry.features;
  if (f[F_FRAC_LIGHT] >= HYBRID_LIGHT_FRACLIGHT && f[F_TEXT_LUM] <= HYBRID_LIGHT_TEXTLUM) {
    return { label: "light", y: Y_LIGHT.slice() }; // conteudo claro: inverte
  }
  if (f[F_FRAC_DARK] >= HYBRID_DARK_FRACDARK && f[F_TEXT_LUM] >= HYBRID_DARK_TEXTLUM) {
    return { label: "dark", y: Y_DARK.slice() }; // conteudo escuro: nao mexe
  }
  return null; // hibrido/ambiguo: de fora
}

// Pura: valida as 32 features (numeros finitos em [0, 1] — as do crawler
// ja vem normalizadas; defesa extra contra registro corrompido).
function validFeatures(f) {
  return f.every((v) => typeof v === "number" && Number.isFinite(v) && v >= -0.001 && v <= 1.001);
}

// Coleta todos os datasets de um diretorio (ordem deterministica: nome de
// arquivo). Diretorio ausente ou vazio -> [] (treino fica so sintetico).
function collect(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((f) => /^report-.*\.json$/.test(f))
    .sort();
  const out = [];
  for (const f of files) {
    let report;
    try {
      report = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      continue; // JSON corrompido: ignora o arquivo inteiro
    }
    if (!Array.isArray(report)) continue;
    for (const entry of report) {
      const lab = labelEntry(entry);
      if (!lab || !validFeatures(entry.features)) continue;
      out.push({
        x: entry.features.map((v) => Math.min(1, Math.max(0, v))),
        y: lab.y,
        label: lab.label,
        host: entry.url || "",
        source: f,
      });
    }
  }
  return out;
}

// Resumo para humanos: quantos registros, por rotulo e por fonte.
function stats(dir) {
  const data = collect(dir);
  const byLabel = { light: 0, dark: 0 };
  for (const r of data) byLabel[r.label]++;
  return { total: data.length, ...byLabel, arquivos: [...new Set(data.map((r) => r.source))] };
}

module.exports = { collect, labelEntry, validFeatures, stats, Y_LIGHT, Y_DARK };
