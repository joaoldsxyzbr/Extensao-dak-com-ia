"use strict";

// Crawler de regressao visual e coleta de dados reais (Extensão Dark com IA).
// Roda FORA da extensaoo, no CI (GitHub Actions) ou na maquina de dev:
//   npm install          (dentro de tools/dev)
//   npx playwright install chromium
//   node crawl.js --fixtures     # fixtures locais deterministicas (gate do CI)
//   node crawl.js --sites sites.txt  # sites reais (coleta de dataset, sem gate duro)
//
// Para cada pagina: carrega SEM a extensao (screenshot "antes") e COM a
// extensao carregada (screenshot "depois"), extrai as 32 features reais
// (darl-features.js injetado), calcula as metricas perceptuais (metrics.js)
// e grava tools/dev/out/<nome>.{antes,depois}.png + relatorio JSON.
// Nas fixtures, cada uma tem um criterio de aprovacao: falhou, o processo
// termina com erro (gate do CI).

const fs = require("fs");
const path = require("path");
const http = require("http");
const { chromium } = require("playwright");
const metrics = require("./metrics.js");

const ROOT = path.join(__dirname, "..", "..");
const OUT_DIR = path.join(__dirname, "out");
const FIXTURES = path.join(__dirname, "fixtures");

// Criterios de aprovacao por fixture (regressao visual com limiar humano):
// o "depois" precisa ser majoritariamente escuro, manter texto visivel
// (desvio de luminancia) e, nos hibridos, cada metade ser escura.
// lumStd e GLOBAL: depende da densidade de texto da fixture. Valores
// calibrados na primeira execucao real do CI (texto visivel, extensao OK):
// light=0.060, hybrid=0.036 — o piso 0.03 pega regressao de "texto apagado"
// (pagina uniforme sem contraste cai para ~0.01), nao o caso saudavel.
const FIXTURE_RULES = {
  "light.html": { darkFrac: 0.55, meanLum: 0.45, lumStd: 0.05 },
  "hybrid.html": { darkFrac: 0.55, meanLum: 0.45, lumStd: 0.03, halvesDarkFrac: 0.5 },
  // casca escura + painel branco sobreposto (Rocket.Chat real): as features
  // por elemento parecem "site escuro", mas o painel central tem que escurecer;
  // o probe de hover prova que a linha clara do :hover original nao vaza;
  // o probe de frame prova que o iframe about:blank (sem content script)
  // escurece pelo motor de frames do documento topo (v4.3.4)
  "hybrid-chat.html": { darkFrac: 0.55, meanLum: 0.45, lumStd: 0.03, halvesDarkFrac: 0.5, hoverProbe: "li.probe", hoverMaxLum: 0.5, frameProbe: "iframe.probe", frameMaxLum: 0.5 },
  "dark.html": { darkFrac: 0.6, maxDeltaE: 45 }, // ja escuro: retoque quase identidade
};

function serveDir(dir) {
  const server = http.createServer((req, res) => {
    const file = path.join(dir, decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "")); // nosemgrep
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end("not found"); return;
    }
    res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function shoot(context, url, name, tag, rule) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  // diagnostico: erros/warnings da extensao (content script) na passada "depois"
  const consoleMsgs = [];
  if (tag === "depois") {
    page.on("console", (m) => {
      const t = m.type();
      if (t === "error" || t === "warning") consoleMsgs.push(`${t}: ${m.text().slice(0, 200)}`);
    });
    page.on("pageerror", (e) => consoleMsgs.push(`pageerror: ${String(e).slice(0, 200)}`));
  }
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1800); // varredura por elemento + rede de imagens
  const shot = path.join(OUT_DIR, `${name}.${tag}.png`);
  await page.screenshot({ path: shot, fullPage: false });
  // probe de interacao: hover real no elemento e screenshot dele sozinho.
  // A guarda de interacao (element.js, v4.2) tem de escurecer o hover
  // claro do tema original na hora - se a linha ficar clara, o gate falha.
  let hover = null;
  if (tag === "depois" && rule && rule.hoverProbe) {
    const target = page.locator(rule.hoverProbe).first();
    if (await target.count()) {
      await target.hover({ force: true }).catch(() => {});
      await page.waitForTimeout(700); // mouseover -> guarda -> flush
      const hoverShot = path.join(OUT_DIR, `${name}.hover.png`);
      await target.screenshot({ path: hoverShot }).catch(() => {});
      const H = metrics.analyze(hoverShot);
      hover = +H.stats.meanLum.toFixed(3);
    }
  }
  // probe de frame (v4.3.4): iframe about:blank não recebe content script —
  // o documento topo tem de remapeá-lo; se a prévia ficar clara, o gate falha.
  let frame = null;
  let frameDiag = null;
  if (tag === "depois" && rule && rule.frameProbe) {
    const target = page.locator(rule.frameProbe).first();
    if (await target.count()) {
      await page.waitForTimeout(600); // passada de frames + varredura do frame
      const frameShot = path.join(OUT_DIR, `${name}.frame.png`);
      await target.screenshot({ path: frameShot }).catch(() => {});
      const F = metrics.analyze(frameShot);
      frame = +F.stats.meanLum.toFixed(3);
      // por que o frame ficou claro? estado do motor de frames por iframe
      frameDiag = await page.evaluate(() => {
        const out = { iframes: [], topStyle: null, elementStyle: null };
        out.elementStyle = Boolean(document.getElementById("darl-element-style"));
        for (const f of document.getElementsByTagName("iframe")) {
          const info = { src: f.getAttribute("src"), url: null, docOk: null, frameStyle: null, marked: 0 };
          try {
            const d = f.contentDocument;
            info.url = d ? d.URL : null;
            info.docOk = Boolean(d && d.documentElement);
            info.frameStyle = Boolean(d && d.getElementById("darl-frame-style"));
            if (d) info.marked = d.querySelectorAll("[darl-frame-el]").length;
          } catch (err) {
            info.docOk = "throw " + String(err).slice(0, 100);
          }
          out.iframes.push(info);
        }
        return out;
      }).catch((err) => ({ error: String(err) }));
    }
  }
  // a extensao aplicou estilos nesta pagina? (diagnostico: no headless-shell
  // do Playwright as extensoes nao carregam e o gate falha sem explicacao)
  const extApplied = await page.evaluate(() => Boolean(
    document.getElementById("darl-dark-style") ||
    document.getElementById("darl-element-style") ||
    document.getElementById("darl-flash-cover")
  )).catch(() => false);
  // features reais da pagina, com a MESMA ordem canonica da extensaoo
  // (ignora os <style> da propria extensao, como o content.js faz)
  const featuresSrc = fs.readFileSync(path.join(ROOT, "darl-features.js"), "utf8");
  const features = await page.evaluate(`${featuresSrc}\n(globalThis.DarlFeatures && DarlFeatures.extract({ skipStyleIds: ["darl-dark-style", "darl-flash-cover", "darl-element-style"] }))`).catch(() => null);
  await page.close();
  return { shot, features, extApplied, hover, frame, frameDiag, consoleMsgs };
}

async function main() {
  const args = process.argv.slice(2);
  const useFixtures = args.includes("--fixtures") || !args.includes("--sites");
  const sitesFile = args.includes("--sites") ? args[args.indexOf("--sites") + 1] : null;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const targets = [];
  if (useFixtures) {
    const server = await serveDir(FIXTURES);
    const base = `http://127.0.0.1:${server.address().port}/`;
    for (const f of Object.keys(FIXTURE_RULES)) targets.push({ name: path.basename(f, ".html"), url: base + f, rule: FIXTURE_RULES[f] });
    globalThis.__closeServer = () => server.close();
  } else {
    const list = fs.readFileSync(sitesFile, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    for (const l of list) targets.push({ name: l.replace(/[^a-z0-9]+/gi, "-").slice(0, 60), url: l, rule: null });
  }

  console.log(`Crawler: ${targets.length} alvo(s)${useFixtures ? " (fixtures, gate de regressao)" : " (sites reais, coleta)"}`);

  // Contexto 1: navegador limpo, sem extensao (o "antes" original).
  // channel: "chromium" usa o Chromium completo (headless novo), nao o
  // headless-shell — so o Chromium completo carrega extensoes em headless.
  const beforeCtx = await chromium.launch({
    headless: true,
    channel: "chromium",
    viewport: { width: 1280, height: 800 },
  });
  // Contexto 2: mesma versao do Chromium com a extensao carregada
  // (perfil persistente temporario: exigencia para carregar extensoes).
  const os = require("os");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "darl-crawl-"));
  const afterCtx = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: "chromium",
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
    ],
  });

  const report = [];
  let failures = 0;

  for (const t of targets) {
    try {
      const before = await shoot(beforeCtx, t.url, t.name, "antes", t.rule);
      const after = await shoot(afterCtx, t.url, t.name, "depois", t.rule);
      const A = metrics.analyze(before.shot);
      const B = metrics.analyze(after.shot);
      const de = metrics.deltaE76(A.img, B.img);
      const entry = {
        name: t.name, url: t.url,
        antes: { meanLum: +A.stats.meanLum.toFixed(3), darkFrac: +A.stats.darkFrac.toFixed(3), lumStd: +A.stats.lumStd.toFixed(3) },
        depois: { meanLum: +B.stats.meanLum.toFixed(3), darkFrac: +B.stats.darkFrac.toFixed(3), lumStd: +B.stats.lumStd.toFixed(3) },
        hover: after.hover,
        frame: after.frame,
        frameDiag: after.frameDiag,
        consoleMsgs: after.consoleMsgs && after.consoleMsgs.length ? after.consoleMsgs : undefined,
        deltaE76: +de.toFixed(1),
        features: after.features,
        extApplied: after.extApplied,
        approved: null,
      };
      if (!after.extApplied) console.warn(`  AVISO ${t.name}: a extensao nao aplicou estilos nesta pagina (nao carregou?)`);

      if (t.rule) {
        const r = t.rule;
        const errs = [];
        if (B.stats.darkFrac < r.darkFrac) errs.push(`darkFrac ${B.stats.darkFrac.toFixed(2)} < ${r.darkFrac}`);
        if (r.meanLum && B.stats.meanLum > r.meanLum) errs.push(`meanLum ${B.stats.meanLum.toFixed(2)} > ${r.meanLum}`);
        if (r.lumStd && B.stats.lumStd < r.lumStd) errs.push(`lumStd ${B.stats.lumStd.toFixed(3)} < ${r.lumStd} (texto apagado?)`);
        if (r.hoverMaxLum != null) {
          if (after.hover == null) errs.push("probe de hover nao rodou");
          else if (after.hover > r.hoverMaxLum) errs.push(`hover claro (meanLum ${after.hover.toFixed(2)} > ${r.hoverMaxLum})`);
        }
        if (r.frameMaxLum != null) {
          if (after.frame == null) errs.push("probe de frame nao rodou");
          else if (after.frame > r.frameMaxLum) {
            errs.push(`frame about:blank claro (meanLum ${after.frame.toFixed(2)} > ${r.frameMaxLum})`);
            // o diagnostico vai junto no report/issue: qual o estado do motor
            if (after.frameDiag) errs.push(`frameDiag ${JSON.stringify(after.frameDiag)}`);
            if (after.consoleMsgs && after.consoleMsgs.length) errs.push(`console ${JSON.stringify(after.consoleMsgs.slice(0, 5))}`);
          }
        }
        if (r.maxDeltaE && de > r.maxDeltaE) errs.push(`deltaE76 ${de.toFixed(1)} > ${r.maxDeltaE} (mexeu demais num site ja escuro)`);
        if (r.halvesDarkFrac) {
          const left = metrics.lumStats(metrics.cropH(B.img, 0, 0.5));
          const right = metrics.lumStats(metrics.cropH(B.img, 0.5, 1));
          if (left.darkFrac < r.halvesDarkFrac) errs.push(`metade escura original clareou (darkFrac ${left.darkFrac.toFixed(2)})`);
          if (right.darkFrac < r.halvesDarkFrac) errs.push(`metade clara nao escureceu (darkFrac ${right.darkFrac.toFixed(2)})`);
        }
        entry.approved = errs.length === 0;
        if (errs.length) { failures++; entry.errors = errs; }
        console.log(`  ${entry.approved ? "OK  " : "FAIL"} ${t.name}: darkFrac ${A.stats.darkFrac.toFixed(2)}->${B.stats.darkFrac.toFixed(2)}  meanLum ${A.stats.meanLum.toFixed(2)}->${B.stats.meanLum.toFixed(2)}  dE76 ${de.toFixed(0)}${errs.length ? "  [" + errs.join("; ") + "]" : ""}`);
      } else {
        console.log(`  ...  ${t.name}: darkFrac ${A.stats.darkFrac.toFixed(2)}->${B.stats.darkFrac.toFixed(2)}  meanLum ${A.stats.meanLum.toFixed(2)}->${B.stats.meanLum.toFixed(2)}  dE76 ${de.toFixed(0)}`);
      }
      report.push(entry);
    } catch (err) {
      failures++;
      console.error(`  ERRO ${t.name}: ${String(err).split("\n")[0]}`);
      report.push({ name: t.name, url: t.url, error: String(err) });
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  console.log(`relatorio: ${path.join(OUT_DIR, "report.json")}`);

  await beforeCtx.close();
  await afterCtx.close();
  if (globalThis.__closeServer) globalThis.__closeServer();
  // Fixtures: gate duro (regressao visual). Sites reais: coleta best-effort —
  // internet e flutuante (DNS, geo-block, bot-wall); erros de site NAO podem
  // pintar o CI de vermelho, os dados validos entram no report do mesmo jeito.
  if (failures > 0 && !useFixtures) {
    console.log(`aviso: ${failures} site(s) com erro na coleta (best-effort, dataset mantido)`);
  }
  process.exit(useFixtures && failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
