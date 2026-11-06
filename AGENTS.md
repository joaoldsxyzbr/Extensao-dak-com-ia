# AGENTS.md — Guia para agentes de código neste repositório

## O que é este projeto

A Extensão Dark com IA é uma extensão Chrome (Manifest V3) de modo escuro com
três mini IAs que rodam inteiramente local — JS puro, zero dependências no
runtime, zero servidor. O modelo de páginas é uma floresta GBDT (v4.0.0);
regiões e imagens seguem como MLPs. A extensão é **inference-only**: todo
treino acontece offline, pelos treinadores em `tools/`; a extensão apenas
executa os pesos. Em páginas claras, o motor por elemento (`element.js`)
remapeia cor por cor no DOM; o modo filtro clássico (inversão + matiz)
continua como caminho para páginas escuras, retina e fallback.

## Regras de ouro (leia antes de tocar em qualquer coisa)

1. **`weights-page.js`, `weights-region.js` e `weights-images.js` são ARQUIVOS GERADOS.**
   Nunca edite à mão. Cada um é regenerado pelo treinador correspondente —
   o header do arquivo marca o gerador (`node tools/train-page-gbdt.js --write`
   para a floresta de páginas, `node tools/train-region-model.js` e
   `node tools/train-image-model.js` para as MLPs). Os treinadores só gravam
   se o treino passar nos critérios (holdout ≥ 99.5%, arquétipos e casos-chave
   sem falha). `tools/train-page-model.js` (MLP de páginas) fica apenas como
   registro histórico do duelo contra o GBDT.
2. **A extensão não treina no navegador.** É decisão deliberada da v2.0.0. Não
   reintroduza backprop/feedback-treino em popup ou content script. A
   coleta de dados reais (dataLog + export no popup) é só observação, para
   alimentar novos arquétipos offline.
3. **A ordem das features é canônica** e deve ser idêntica em três lugares:
   `tools/page-dataset.js` (constante `ORDER` dos arquétipos),
   `darl-features.js` (extrator compartilhado entre content script e crawler)
   e `tools/test-nn.js`. Mudou em um, mudou nos três — e a floresta de páginas
   precisa ser retreinada.
4. **Portão de qualidade**: `node tools/test-nn.js` precisa passar antes de
   commit. Para todo arquivo JS alterado, rode `node --check <arquivo>`.
5. **Idioma**: comentários, docs e mensagens de UI em pt-BR. Commit com mensagem
   descritiva (veja `git log` para o estilo).
6. **Sem dependências e sem build step no runtime.** JS puro na extensão,
   Python stdlib nos scripts de suporte. Exceção única: `tools/dev/` (crawler
   Playwright de regressão visual), que tem `package.json` próprio, nunca é
   carregado pela extensão e só roda no CI/desenvolvimento. Não introduzir
   bundler ou libs em nenhum outro lugar.

## Comandos

| Comando | Efeito |
|---|---|
| `node tools/test-nn.js` | Suite completa: arquétipos das 3 redes, floresta GBDT, motor por elemento, matriz SVG, calibração, guardas (62 testes) |
| `node tools/train-page-gbdt.js --write` | Retreina a floresta de páginas e regenera `weights-page.js` |
| `node tools/train-region-model.js` | Retreina rede de regiões e regenera `weights-region.js` |
| `node tools/train-image-model.js` | Retreina rede de imagens e regenera `weights-images.js` |
| `python tools/generate_icons.py` | Regenera os ícones PNG (ícones são artefatos comitados) |

Registros históricos: `tools/train-page-model.js` (MLP de páginas, pré-GBDT).
Regressão visual (`tools/dev/`, requer `npm install` dentro da pasta):
`node tools/dev/crawl.js` roda o crawler sobre as fixtures — o mesmo gate do
job `visual` do CI (`.github/workflows/ci.yml`), que roda a cada push; o job
`crawl-real` visita sites reais semanalmente e publica o dataset como artefato.

Testar a extensão: carregar sem compactação em `chrome://extensions`.

## Como ajustar o comportamento da IA

O comportamento das redes é definido pelos **arquétipos** (dados do professor)
em `tools/page-dataset.js` (páginas) e nos treinadores de região/imagem.
Fluxo para mudar como a IA trata páginas:

1. Edite/adicione o arquétipo em `tools/page-dataset.js` (features por nome,
   alvos em `y`, variação em `vary`).
2. Rode `node tools/train-page-gbdt.js` — ele valida em holdout e nos
   casos-chave. Se os testes codificam uma expectativa que o novo
   comportamento quebra, decida: era expectativa certa (volte o professor)
   ou estava desatualizada (atualize o teste explicitamente no mesmo commit).
3. Com `--write`, os pesos regeneram; recarregue a extensão.

Detalhe fino que já pegou dois bugs reais: **interpolações entre arquétipos não
podem sobrescrever alvos especiais** (ex.: o `dim` do DARK é calculado por amostra a
partir do `htmlBg`; misturas com BLUE_DASH interpolam, não sobrescrevem).

## Como adicionar uma feature de página (32 → N)

1. Adicione o nome+índice no `ORDER` de `tools/page-dataset.js` e no `ORDER`
   de `tools/test-nn.js`.
2. Implemente a extração em `darl-features.js` (amostra até 400 elementos —
   features precisam ser baratas: `getComputedStyle` já é o custo dominante).
   O crawler em `tools/dev/crawl.js` usa o mesmo módulo: nada fica fora de
   sincronia.
3. Alimente a feature nos arquétipos que a distinguem e retreine com
   `--write`.
4. Mudou a ordem/dimensões? A guarda de compatibilidade (`DarlModel` /
   `DarlNN.compatible`) descarta pesos antigos — bump de versão no
   `manifest.json` e nota no `CHANGELOG.md`.

## Ciclo de melhoria com dados reais (v4)

1. Navegue com a extensão; o content script registra host + features +
   decisão em `dataLog` (storage.local, ≤500 páginas).
2. No popup, "Exportar dados de navegação" baixa um JSON via
   `chrome.downloads`. Nada sai do navegador sem esse clique.
3. Offline: página-problema no JSON (ou relato manual) vira arquétipo/
   `vary` em `tools/page-dataset.js`, e quando possível um teste que fixa a
   expectativa. Retreino, suite, commit.
4. Casos visuais: replique num fixture de `tools/dev/fixtures/` e deixe o
   job `visual` guardar para sempre.

## Invariantes que não podem quebrar

- **Caps WCAG no ramo de inversão** (`content.js`, `computeDecision`): contraste
  limitado a 0.90 e piso de `tint` 0.03. Branco invertido vira ~#191919, não #000
  (anti-halation). Há testes cobrindo os valores.
- **Motor por elemento**: texto remapeado precisa manter contraste WCAG AA
  (4.5:1) contra o novo fundo; fotos/vídeos (`img.dd-keep` e mídia) jamais
  invertidos; acima de 4000 elementos ou em erro, fallback para modo filtro.
- **`invertNHue` é involutiva** — é a base do reverso de mídias/regiões no modo SVG.
- **`DarlNN.calibrate` é monótona** e fixa p=0.5 — a decisão de limiar nunca muda
  com temperatura.
- Formatos de pesos: MLP `{dims, W, b[, temp]}`; floresta
  `{kind:"gbdt", lr, base, nOut, trees[, temp]}`. A guarda de compatibilidade
  rejeita qualquer coisa fora deles. `DarlModel` (em `nn.js`) despacha os dois.
- **Treino determinístico**: o GBDT usa seed fixa; dois treinos produzem
  `weights-page.js` byte-idêntico — o CI confere isso com `git diff --exit-code`.
- Respeito a acessibilidade: `forced-colors` → não interferir; `@media print` →
  página original; `<meta name="darkreader-lock">` → não mexer.

## Mapa dos arquivos

| Arquivo | Papel | Editável à mão? |
|---|---|---|
| `content.js` | Decisão, CSS, anti-flash, regiões, imagens, dataLog | sim |
| `darl-features.js` | Extração das 32 features (compartilhada com o crawler) | sim |
| `element.js` | Motor por elemento: varredura incremental do DOM, remapeamento de cores, fallback para filtro | sim |
| `nn.js` | Motor MLP genérico + floresta GBDT (`loadForest`) + `DarlModel` + `DarlMatrix` | sim |
| `weights-page.js` (floresta) / `weights-region.js` / `weights-images.js` | Pesos + temperatura calibrada | **NÃO** (gerados) |
| `popup.html/css/js` | Interface: leitura das decisões, chaves globais, modo elementos, export de dados | sim |
| `background.js` | Atalho Alt+Shift+D, migração de schema no `onInstalled` | sim |
| `tools/gbdt.js` | Gradient boosting multi-saída (CART, JS puro) | sim |
| `tools/page-dataset.js` | Arquétipos de páginas (professor compartilhado) | sim |
| `tools/train-page-gbdt.js` | Treinador da floresta de páginas + gate de qualidade | sim |
| `tools/train-page-model.js` | Registro histórico: MLP de páginas do duelo v4 | sim |
| `tools/nnlab.js` | Laboratório MLP: Adam, mini-batch, cosine LR, weight decay, holdout, early stop, calibração | sim |
| `tools/train-*.js` (região/imagem) | Treinadores (professor + geração de pesos) | sim |
| `tools/test-nn.js` | Suite de regressão (62 testes) | sim (expectativas explícitas) |
| `tools/generate_icons.py` | Geração de ícones PNG com supersampling | sim |
| `tools/dev/` | Crawler Playwright, métricas perceptuais, fixtures, dataset de sites reais | sim (deps só no CI/dev) |

Documentação ampla em [ARCHITECTURE.md](ARCHITECTURE.md); histórico em
[CHANGELOG.md](CHANGELOG.md); fluxo de contribuição em [CONTRIBUTING.md](CONTRIBUTING.md).
