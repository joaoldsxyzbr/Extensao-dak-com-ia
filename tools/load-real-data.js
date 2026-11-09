// Rotulagem por CONTEUDO ANTES DA APARENCIA (v4.3.5). O screenshot mente:
// hero escuro arrasta o meanLum de paginas claras (gitlab/harvard/apple no
// dataset real), tema em cookie escurece o que o crawler limpo renderiza
// claro, e media colorida enche a zona cinza. As features por elemento nao
// mentem (v4.3.1 comprovou; v4.3.5 generaliza para TODAS as paginas, nao
// so as de screenshot cinza). Indices = ordem canonica (page-dataset.js
// ORDER2): 11 fracDark, 12 fracLight, 13 textLum, 14 lowContrast.
//
//   conteudo claro (fracLight >= 0.85)  -> inverter (familia LIGHT)
//     — pagina clara atras de hero escuro/colorido; o texto medio pode ser
//       claro (texto branco do hero), por isso nao se exige textLum baixo.
//   conteudo escuro (fracDark >= 0.85):
//     texto claro E legivel (textLum >= 0.60, lowC <= 0.25) -> retoque (DARK)
//     texto com contraste ruim contra o fundo herdado (lowC >= 0.50,
//       textLum <= 0.60) -> HIBRIDO de casca escura: inverter (LIGHT) com
//       motor por elemento (caso Rocket.Chat/php.net: casca fica, painel
//       claro escurece). Num site escuro de verdade o texto e claro E o
//       contraste medido e bom (v4.1).
//     senao -> ambiguo: DESCARTADO
//   aparencia (fallback do conteudo): claro/escuro como antes; zona cinza
//     sem assinatura de conteudo continua descartada.
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

// Rotulagem por CONTEUDO (v4.3.5). Medido no dataset real de 06/11 (120
// sites): escuro verdadeiro tem fracDark >= 0.95, textLum >= 0.61 e
// lowContrast <= 0.11; claro atras de hero escuro tem fracLight >= 0.95 e
// fracDark <= 0.04; hibrido de casca escura tem fracDark >= 0.96 com
// lowContrast >= 0.62 (php.net) — as margens entre os grupos sao enormes.
const F_FRAC_DARK = 11;
const F_FRAC_LIGHT = 12;
const F_TEXT_LUM = 13;
const F_LOW_CONTRAST = 14;
const CONTENT_LIGHT_FRACLIGHT = 0.85; // maioria dos elementos clara = pagina clara
const CONTENT_DARK_FRACDARK = 0.85; // maioria dos elementos escura = escuro ou hibrido
const CONTENT_DARK_TEXTLUM = 0.6; // escuro de verdade: texto claro...
const CONTENT_DARK_LOWC = 0.25; // ...E legivel contra o fundo escuro
const HYBRID_DARKSHELL_LOWC = 0.5; // casca escura: texto claro acha contraste RUIM...
const HYBRID_DARKSHELL_TEXTLUM = 0.6; // ...contra o fundo herdado (baixa legibilidade)

// Pura: dado um registro do report.json, devolve {label, y} ou null se o
// rotulo nao e confiavel. Testavel sem filesystem.
function labelEntry(entry) {
  if (!entry || entry.error) return null;
  if (!Array.isArray(entry.features) || entry.features.length !== IN) return null;
  const a = entry.antes;
  if (!a || typeof a.meanLum !== "number" || typeof a.darkFrac !== "number" || typeof a.lumStd !== "number") return null;
  if (a.lumStd < BLANK_LUMSTD) return null; // blank/erro: sem rotulo
  const f = entry.features;
  // CONTEUDO ANTES DA APARENCIA (v4.3.5): o screenshot mente (hero escuro,
  // midias, tema em cookie); as features por elemento nao.
  if (f[F_FRAC_LIGHT] >= CONTENT_LIGHT_FRACLIGHT) {
    return { label: "light", y: Y_LIGHT.slice() }; // conteudo claro: inverte
  }
  if (f[F_FRAC_DARK] >= CONTENT_DARK_FRACDARK) {
    if (f[F_LOW_CONTRAST] >= HYBRID_DARKSHELL_LOWC && f[F_TEXT_LUM] <= HYBRID_DARKSHELL_TEXTLUM) {
      // hibrido de casca escura: inverte com motor por elemento (a casca
      // fica escura, o painel claro escurece) — caso Rocket.Chat.
      return { label: "light", y: Y_LIGHT.slice() };
    }
    if (f[F_TEXT_LUM] >= CONTENT_DARK_TEXTLUM && f[F_LOW_CONTRAST] <= CONTENT_DARK_LOWC) {
      return { label: "dark", y: Y_DARK.slice() }; // escuro de verdade: nao mexe
    }
    return null; // escuro ambiguo: sem confianca
  }
  // Fallback por APARENCIA quando o conteudo nao decide.
  if (a.meanLum > LIGHT_MEANLUM && a.darkFrac < LIGHT_DARKFRAC) {
    return { label: "light", y: Y_LIGHT.slice() };
  }
  if (a.meanLum < DARK_MEANLUM && a.darkFrac > DARK_DARKFRAC) {
    return { label: "dark", y: Y_DARK.slice() };
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
