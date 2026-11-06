# Histórico de versões — Extensão Dark com IA

Formato inspirado em Keep a Changelog; datas omitidas (repositório pessoal).

## [4.0.0] — motor por elemento, GBDT e ciclo de dados reais

### Adicionado
- Motor de análise por elemento (`element.js`): em páginas claras, a extensão
  lê o estilo computado de cada nó do DOM e remapeia cor por cor — fundos
  claros escurecem com o matiz preservado, textos escuros clareiam com guarda
  WCAG AA (4.5:1), bordas, sombras, gradientes e `fill`/`stroke` de SVG junto.
  Páginas híbridas (sidebar escura + chat claro, o caso Prado/Telegram-web)
  ficam certas sem rede de regiões; fotos e vídeos ficam intactos por
  construção. Varredura incremental com `requestIdleCallback`, teto de 4000
  elementos e re-scan throttled para SPAs; acima do teto ou em erro, fallback
  automático para o modo filtro clássico. `color-scheme: dark` escurece
  controles nativos e scrollbar.
- Floresta GBDT no lugar da MLP para o modelo de páginas: `tools/gbdt.js`
  (gradient boosting multi-saída, JS puro) + `tools/train-page-gbdt.js` com
  o mesmo portão de qualidade (holdout ≥ 99.5%, arquétipos e casos-chave).
  No duelo contra a MLP v3: MSE 0.00019 vs 0.00116, PRADO 1.00 vs 0.97,
  TELEGRAM_DARK 0.00, 100% de acurácia. Despachante `DarlModel` em `nn.js`
  abstrai floresta e MLP; a floresta fica em `weights-page.js` (80 árvores,
  profundidade 3, T=0.3, determinística).
- Coleta de dados reais opt-in: o content script registra host + 32 features
  + decisão da IA em `chrome.storage.local.dataLog` (≤500 páginas, sem
  querystring) e o popup exporta um JSON via `chrome.downloads`
  ("Exportar dados de navegação"). Nada sai do navegador sem o clique.
- Regressão visual no CI: `tools/dev/` traz um crawler Playwright (antes/depois
  com a extensão carregada), métricas perceptuais em Node puro (PNG decodificado
  com zlib: luminância, fração escura, desvio de luminância, deltaE76) e
  fixtures determinísticas (`light`, `hybrid`, `dark`) com critérios de
  aprovação. O job `visual` roda a cada push; o job `crawl-real` visita sites
  reais semanalmente e publica o dataset como artefato.
- `darl-features.js`: extração de features sai do `content.js` e vira módulo
  compartilhado com o crawler — a ordem canônica agora vive num lugar só.
- 10 testes novos do motor por elemento (mapeamento de fundo/texto/gradiente/
  sombra/alpha, WCAG) e round-trip da floresta: 62 no total.

### Alterado
- `weights-page.js` agora é uma floresta GBDT gerada por
  `tools/train-page-gbdt.js --write` (o MLP trainer antigo segue como
  registro histórico do duelo). CI atualizado para reproduzir a floresta.
- Permissão `downloads` adicionada (export do JSON de dados).
- Dependências (Playwright) confinadas a `tools/dev/` — runtime da extensão
  continua JS puro, sem build.

## [3.0.0] — modelo de páginas v3: 14 arquétipos + reanálise estável

### Corrigido
- Extração de features imune aos estilos da própria extensão: a tampa
  anti-flash escura (primeira análise) e o fundo branco do modo inversão
  (reanálises) poluíam o htmlBg e o histograma — a causa de "reanalisar
  piora". A extração agora lê sempre a página original.

### Alterado
- Rede de páginas ampliada de 32→24→16 para 32→32→24 com pesos retreinados
  no pipeline nnlab (holdout 100% na decisão de inverter).
- Pesos da v2.2.0 estavam desatualizados em relação ao treinador expandido:
  a suíte estava vermelha (4 falhas) e o CI da main quebrado. Agora pesos,
  treinador e testes estão consistentes.

### Adicionado
- Arquétipos novos no treinador (totais 14): SHOP, SEARCH_MIN, SOCIAL_FEED,
  LONGFORM, GALLERY, DARK_POLISHED e OLED_BLACK — mensagens híbridas, lojas,
  buscadores, feeds, longa-leitura, galerias, temas escuros bem desenhados
  (Telegram/Discord/GitHub dark, retoque quase identidade) e AMOLED.
- Casos-chave nos testes: PRADO (híbrido pesado, confiança antes ~67%) e
  TELEGRAM_DARK (tema nativo escuro, antes ~47% na fronteira da decisão).

## [2.2.0]

### Adicionado
- Arquétipo MESSAGING na rede de páginas (treinador): apps de mensagens
  híbridos (painel lateral escuro + área de chat clara) agora recebem decisão
  de inversão com confiança alta — antes ficavam na fronteira (~56%).
- Caso-chave no test-nn.js fixando a expectativa para páginas de mensagens.

### Removido
- Botão "Copiar dados da análise" do popup (a cópia falhava no Chrome) e o
  handler correspondente no content script.

## [2.1.0]

### Adicionado
- Botão "Copiar dados da análise" no popup: copia para a área de transferência
  o vetor de 32 features da página atual e a decisão da IA (JSON) — gera dados
  de treino reais a partir de qualquer site.

### Alterado
- Nome do projeto corrigido de "Darl Dark" para "Extensão Dark com IA"
  (manifest, popup e documentação; sem mudança de comportamento).

## [2.0.0] — extensão inference-only + pipeline de treino moderno

**Quebra de comportamento**: o feedback no popup não treina mais nada — decisão de
projeto. A inteligência vive nos treinadores offline; a extensão apenas executa.

### Adicionado
- `tools/nnlab.js`: laboratório de treino compartilhado — Adam (com bias
  correction), mini-batches com shuffle, cosine decay de LR com warmup, weight
  decay, split holdout, early stopping com checkpoint, inicialização Xavier e
  calibração de temperatura (Guo et al. 2017) por NLL no holdout.
- `tools/train-image-model.js`: treinador da rede de imagens (antes os pesos eram
  escritos a mão a partir de um treino avulso).
- Temperatura calibrada embutida em cada arquivo de pesos; `DarlNN.calibrate` no
  motor; popup exibe confiança honesta.

### Alterado
- Os três treinadores passam a usar o nnlab: 100% de acerto em holdout, nuance dos
  arquétipos confirmada nos centros (HARSH 0.85 vs LIGHT 0.95; DARK 0.81 vs
  BLUE_DASH 0.89).
- Interpolação de arquétipos (15%) apenas dentro da mesma família — misturar as
  famílias ambigua a saída `inverter`; misturar demais dilui os centros.

### Corrigido (bugs de professor achados pelos testes)
- O dim do BLUE_DASH era sobrescrito pela fórmula do DARK nas amostras interpoladas.
- A nuance "branco duro mais escuro" estava abaixo do ruído do alvo; professor
  reforçou a separação.

### Removido
- Botões de feedback e todo o treino no navegador (popup, storage de pesos).
- `onInstalled` limpa `nnWeights` legado de versões anteriores.

## [1.6.0] — boas práticas (pesquisa Dark Reader + WCAG)

### Adicionado
- Modo SVG Filter+ experimental ("Cores mais fiéis"): cadeia
  sépia × grayscale × `invertNHue` × brilho × contraste compilada numa única
  `feColorMatrix` 5×5; `invertNHue` preserva o matiz e é o próprio reverso
  (involutiva). Motor `DarlMatrix` em `nn.js`.
- Mapeamento WCAG: contraste invertido limitado a 0.90 e piso de dessaturação —
  branco vira ~#191919 e texto ~#ddd (anti-halation), validado em teste.
- Respeito a `<meta name="darkreader-lock">` (convenção do ecossistema).
- Acessibilidade: `forced-colors` desativa a intervenção; `@media print` imprime
  a página original.
- Aviso no popup sobre dark nativo do Edge.

## [1.5.0] — anti-flash e rede de regiões

### Adicionado
- Boot cover: tampa escura em `document_start` com timeout de segurança (450ms);
  cache do host como fast path.
- Rede de regiões (8→12→1) + `tools/train-region-model.js`: blocos escuros
  grandes em páginas invertidas recebem `dd-region` e mantêm as cores originais
  (headers, footers, heros, cards de código). Painéis cinzas seguem a página.

## [1.4.0] — modelo de páginas v2

### Adicionado
- 32 features (era 11): histograma de luminância, contraste do texto, saturação,
  fontes mono/título/pequenas, `position:fixed`, marcadores semânticos.
- 6 saídas (era 4): ganhou `dim` (retoque por nível de escuridão) e `tint`.
- Formato de pesos genérico `{dims, W, b}` com guarda de compatibilidade.
- `tools/train-page-model.js`: treinador versionado que gera `weights-page.js`.

## [1.3.0] — só a IA decide

### Removido
- Ajuste manual por site (radios do popup, sliders, `manualSites`); a rede decide
  tudo. Migração remove a chave legada.

## [1.2.0] — IA por imagem

### Adicionado
- Rede de imagens (6→12→1): cada `<img>` decodificada em canvas 16×16; decide
  restaurar ou manter invertida (ícones escuros transparentes ficam visíveis).
- `nn.js` vira motor genérico (`makeNet` com dims arbitrárias).
- Corrigida regressão: fotos opacas muito escuras voltam ao original.

## [1.1.0] — robustez

### Adicionado
- Cache anti-flash por host (≤300 hosts), botão "Reanalisar", guardas de erro em
  todo o pipeline, migração de schema no `onInstalled`, README.

## [1.0.0] — primeira versão

- Extensão MV3 base: rede de páginas (11→16→12→4) treinada, popup com análise e
  feedback que treinava no navegador, fundo das decisões em CSS filter.
