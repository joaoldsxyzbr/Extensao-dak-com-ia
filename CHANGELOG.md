# Histórico de versões — Extensão Dark com IA

Formato inspirado em Keep a Changelog; datas omitidas (repositório pessoal).

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
