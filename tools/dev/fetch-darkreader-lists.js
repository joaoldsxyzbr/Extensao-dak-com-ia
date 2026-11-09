// Gerador de listas de sites a partir dos .config do Dark Reader (MIT).
// Executar: node tools/dev/fetch-darkreader-lists.js [--out <dir>]
//
// As listas do Dark Reader (darkreader/darkreader, src/config/*.config, MIT)
// NAO sao datasets de treino: sao listas de HOSTS com a expectativa de tema
// que o Dark Reader adota para cada um. O modelo de paginas aprende por
// FEATURES (32), e features so existem depois de visitar a pagina — por isso
// estas listas sao materia-prima do CRAWLER (crawl.js --sites), nao do
// treinador. O rotulo continua vindo do que a pagina e de fato (screenshot
// "antes" + regras do load-real-data.js); a lista so escolhe O QUE visitar.
//
// Saidas (uma URL por linha, comentarios com #):
//   sites-dark.txt        -> dark-sites.config: sites com dark nativo.
//                            Reforca a classe "nao mexer" (retoque), que no
//                            dataset real de 06/11 tinha so 11 registros
//                            contra 93 claros.
//   sites-hybrid.txt      -> detector-hints.config, blocos com MATCH: sites
//                            onde o dark e DETECTADO por seletor
//                            ([data-theme="dark"], [data-bs-theme="dark"]...).
//                            Sao os hibridos reais (caso Rocket.Chat) —
//                            justamente o que o load-real-data.js descarta
//                            quando a aparencia fica na zona cinza.
//   sites-hard-light.txt  -> dynamic-theme-fixes.config: sites CLAROS onde o
//                            motor dinamico do Dark Reader precisou de
//                            correcao manual — os padroes de CSS que quebram
//                            motores genericos. Materia-prima de arquetipos.
//
// Fora de proposito: inversion-fixes.config (mistura sites claros e escuros
// na mesma lista — o rotulo em bloco seria errado) e static-themes.config
// (7 hosts, sem valor estatistico). O detector-hints com NO DARK THEME /
// SYSTEM THEME tambem fica fora: o indicio e fraco demais para justificar
// uma lista propria.
//
// Rede: baixa os .config de raw.githubusercontent.com a cada execucao (as
// listas mudam com frequencia). Sem dependencias: fetch + fs do Node 18+.
// Os arquivos gerados sao artefatos locais (tools/dev/out/), nao commitados.
"use strict";

const fs = require("fs");
const path = require("path");

const REPO = "darkreader/darkreader";
const BRANCH = "main";
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/src/config/`;
const SEPARATOR = /^\s*={8,}\s*$/m; // "=================================" entre blocos

// Host puro ou com curinga de subdominio: "example.com", "*.example.com".
// Nada de seletor CSS, token em caixa alta ou URL com esquema.
const HOST_RE = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

// --------------------------------------------------------------- parsing

// Pura: linhas do topo de um bloco que sao hosts (para no primeiro token que
// nao e host — MATCH, TARGET, NO DARK THEME, CSS...). Preserva a ordem e
// remove duplicatas.
function topHosts(blockLines) {
  const hosts = [];
  const seen = new Set();
  for (const raw of blockLines) {
    const line = String(raw).trim();
    if (!line) continue;
    if (!HOST_RE.test(line)) break;
    const host = line.toLowerCase();
    if (!seen.has(host)) {
      seen.add(host);
      hosts.push(host);
    }
  }
  return hosts;
}

// Pura: divide um .config em blocos (separados por linha de "=====").
function splitBlocks(text) {
  return String(text)
    .replace(/\r\n?/g, "\n")
    .split(SEPARATOR)
    .map((b) => b.split("\n"));
}

// Pura: hosts de dark-sites.config — o arquivo e so a lista, um host por linha.
function parseDarkSites(text) {
  const hosts = [];
  const seen = new Set();
  for (const raw of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!HOST_RE.test(line)) continue;
    const host = line.toLowerCase();
    if (!seen.has(host)) {
      seen.add(host);
      hosts.push(host);
    }
  }
  return hosts;
}

// Pura: hosts dos blocos do detector-hints que detectam dark por SELETOR
// (token MATCH). Blocos NO DARK THEME / SYSTEM THEME ficam de fora.
function parseDetectorHints(text) {
  const hosts = [];
  const seen = new Set();
  for (const block of splitBlocks(text)) {
    if (!block.some((l) => l.trim() === "MATCH")) continue;
    for (const host of topHosts(block)) {
      if (!seen.has(host)) {
        seen.add(host);
        hosts.push(host);
      }
    }
  }
  return hosts;
}

// Pura: hosts de dynamic-theme-fixes.config — todos os blocos (o arquivo tem
// um bloco por site, com INVERT/CSS/IGNORE...). Tudo que o topo do bloco
// declara como host entra.
function parseDynamicThemeFixes(text) {
  const hosts = [];
  const seen = new Set();
  for (const block of splitBlocks(text)) {
    for (const host of topHosts(block)) {
      if (!seen.has(host)) {
        seen.add(host);
        hosts.push(host);
      }
    }
  }
  return hosts;
}

// Curinga "*.example.com" nao e um host navegavel: para o crawler vale o
// dominio base. Mantem a raiz e descarta o curinga (o subdominio especifico
// nao e conhecido).
function toUrl(host) {
  return `https://${host.replace(/^\*\./, "")}`;
}

// --------------------------------------------------------------- saida

function header(title, source, note) {
  return [
    `# ${title}`,
    `# Gerado por tools/dev/fetch-darkreader-lists.js — NAO editar a mao.`,
    `# Fonte: ${RAW}${source} (darkreader/darkreader, licenca MIT).`,
    ...note.map((n) => `# ${n}`),
    `# Uso: node tools/dev/crawl.js --sites tools/dev/out/${source.replace(/\.config$/, "")}.txt`,
    "",
  ].join("\n");
}

function writeList(outDir, file, text, source, title, note) {
  const urls = text.split("\n").filter((u) => u && !u.startsWith("#"));
  const body = urls.join("\n");
  const dest = path.join(outDir, file);
  fs.writeFileSync(dest, header(title, source, note) + body + "\n");
  return { dest, count: urls.length };
}

// --------------------------------------------------------------- rede

async function fetchConfig(name) {
  const url = RAW + name;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} em ${url}`);
  return res.text();
}

// --------------------------------------------------------------- main

async function main() {
  const outIdx = process.argv.indexOf("--out");
  const outDir = path.resolve(
    __dirname,
    outIdx >= 0 && process.argv[outIdx + 1] ? process.argv[outIdx + 1] : "out"
  );
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Baixando os .config do Dark Reader (${BRANCH})...`);
  const [dark, hints, fixes] = await Promise.all([
    fetchConfig("dark-sites.config"),
    fetchConfig("detector-hints.config"),
    fetchConfig("dynamic-theme-fixes.config"),
  ]);

  // Um mesmo site pode aparecer em blocos diferentes (ex.: wikisource.org com
  // secoes distintas) e curingas diferentes podem cair no mesmo dominio:
  // deduplica DEPOIS de virar URL.
  const unique = (hosts) => [...new Set(hosts.map(toUrl))];
  const darkHosts = unique(parseDarkSites(dark));
  const hybridHosts = unique(parseDetectorHints(hints));
  const hardLightHosts = unique(parseDynamicThemeFixes(fixes));

  const results = [
    writeList(outDir, "sites-dark.txt", darkHosts.join("\n"), "dark-sites.config",
      "Sites com dark mode NATIVO (classe \"nao mexer\"/retoque).",
      [
        "O Dark Reader pula estes por terem tema escuro proprio; aqui entram para",
        "reforcar a classe escura do dataset real (93 claros vs 11 escuros em 06/11).",
      ]),
    writeList(outDir, "sites-hybrid.txt", hybridHosts.join("\n"), "detector-hints.config",
      "Sites onde o dark e DETECTADO por seletor (hibridos reais).",
      [
        "Blocos com MATCH do detector-hints (ex.: [data-theme=\"dark\"],",
        "[data-bs-theme=\"dark\"]). Sao os hibridos que o load-real-data.js hoje",
        "descarta por ambiguidade de aparencia — o caso Rocket.Chat.",
      ]),
    writeList(outDir, "sites-hard-light.txt", hardLightHosts.join("\n"), "dynamic-theme-fixes.config",
      "Sites CLAROS dificeis (o motor do Dark Reader precisou de correcao manual).",
      [
        "Padroes de CSS que quebram motores genericos — materia-prima de arquetipos",
        "e de fixtures de regressao visual.",
      ]),
  ];

  for (const r of results) {
    console.log(`  ${path.relative(process.cwd(), r.dest)}: ${r.count} sites`);
  }
  console.log("Listas prontas. Nada foi alterado no treino: revise antes de crawlear.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Falha ao gerar as listas do Dark Reader:", err.message || err);
    process.exit(1);
  });
}

module.exports = {
  topHosts,
  splitBlocks,
  parseDarkSites,
  parseDetectorHints,
  parseDynamicThemeFixes,
  toUrl,
};
