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
- `fetch-darkreader-lists.js` — gera listas de sites a partir dos `.config`
  do Dark Reader (MIT), para alimentar o crawler. Ver abaixo.

## Uso

```bash
cd tools/dev
npm install
npx playwright install chromium
node crawl.js --fixtures      # gate de regressão visual (CI roda isto)
node crawl.js --sites sites.txt  # coleta em sites reais
node fetch-darkreader-lists.js   # gera listas do Dark Reader em out/
```

## Listas do Dark Reader

Os `.config` do Dark Reader (`darkreader/darkreader`, `src/config/`, MIT) são
listas de **hosts** com a expectativa de tema de cada um — **não** são
datasets de treino. O modelo de páginas aprende por features (32), e features
só existem depois de visitar a página: as listas escolhem **o que crawlear**;
o rótulo continua vindo do que a página é de fato (screenshot "antes" +
regras do `load-real-data.js`).

`node fetch-darkreader-lists.js` baixa os `.config` da branch `main` e escreve
em `out/` (artefatos locais, não commitados):

| Lista | Fonte | Para quê |
|---|---|---|
| `sites-dark.txt` | `dark-sites.config` | Sites com dark nativo — reforça a classe escura (no dataset de 06/11 eram só 11 contra 93 claros) |
| `sites-hybrid.txt` | `detector-hints.config` (blocos `MATCH`) | Híbridos reais detectados por seletor (`[data-theme="dark"]`) — o caso Rocket.Chat que o `load-real-data.js` hoje descarta |
| `sites-hard-light.txt` | `dynamic-theme-fixes.config` | Páginas claras onde o motor do Dark Reader precisou de correção manual — matéria-prima de arquétipos |

Ficam de fora `inversion-fixes.config` (mistura sites claros e escuros na
mesma lista — rótulo em bloco seria errado) e `static-themes.config`
(7 hosts, sem valor estatístico). Os curingas `*.example.com` viram o domínio
base.

O fluxo é o mesmo do dataset real: crawlear → `out/report.json` →
copiar para `data/report-<data>.json` → `node tools/train-page-gbdt.js --write`.
Como os registros entram no treino com peso 8, revise o balanceamento antes de
somar uma lista inteira de 3 mil sites.

> **Antes de crawlear, leia "O teto dos dados reais" em
> [ARCHITECTURE.md](../../ARCHITECTURE.md#o-teto-dos-dados-reais-medido-não-estimado).**
> Medição nos 104 registros de 06/11: somar dados reais moveu o acerto no
> holdout real em **0,0 pontos percentuais**. O gargalo é o rótulo do
> `load-real-data.js` (decide pela aparência do screenshot, e o crawler usa
> perfil limpo), não a quantidade de páginas. `sites-hybrid.txt` é a lista
> com ganho real; `sites-dark.txt` só ajuda depois de corrigir a regra.

## O ciclo do dataset real

1. Navegue normalmente; o popup tem "Exportar dados de navegação" (JSON com
   host, features e decisão da IA de cada página vista).
2. Rode o crawler semanal (CI) ou local com seus próprios sites.
3. Com os registros em mãos, amplie os arquétipos em `tools/page-dataset.js`
   ou treine diretamente o GBDT com os dados reais — a floresta aceita
   qualquer `[{x: 32 features, y: 6 saídas}]`.
