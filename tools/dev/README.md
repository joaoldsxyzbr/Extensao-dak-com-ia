# tools/dev — ferramentas de desenvolvimento

Nada aqui vai para o runtime da extensão. São as ferramentas que trazem
dados reais e verificação visual para o projeto (a extensão em si continua
JS puro, sem dependências e sem build).

## Componentes

- `crawl.js` — crawler Playwright. Para cada página tira screenshot "antes"
  (navegador limpo) e "depois" (com a extensão carregada), extrai as 32
  features reais via `darl-features.js` (mesma ordem canônica da extensão) e
  grava tudo em `out/report.json`.
- `metrics.js` — métricas perceptuais em Node puro (PNG decodificado com
  zlib nativo): luminância média, fração escura, desvio de luminância (proxy
  de legibilidade do texto) e deltaE76 antes→depois. É o auto-labeling: um
  "depois" bom é escuro com texto ainda visível; um "depois" ruim é claro,
  apagado ou destruído.
- `fixtures/` — páginas locais determinísticas com regras de aprovação:
  `light.html` (blog claro), `hybrid.html` (mensagens híbridas, o caso Prado)
  e `dark.html` (site já escuro, retoque quase identidade). O CI roda esse
  gate a cada push.
- `sites.txt` — sites reais visitados pelo job semanal do CI (coleta de
  dataset, sem gate duro de aprovação).

## Uso

```bash
cd tools/dev
npm install
npx playwright install chromium
node crawl.js --fixtures      # gate de regressão visual (CI roda isto)
node crawl.js --sites sites.txt  # coleta em sites reais
```

## O ciclo do dataset real

1. Navegue normalmente; o popup tem "Exportar dados de navegação" (JSON com
   host, features e decisão da IA de cada página vista).
2. Rode o crawler semanal (CI) ou local com seus próprios sites.
3. Com os registros em mãos, amplie os arquétipos em `tools/page-dataset.js`
   ou treine diretamente o GBDT com os dados reais — a floresta aceita
   qualquer `[{x: 32 features, y: 6 saídas}]`.
