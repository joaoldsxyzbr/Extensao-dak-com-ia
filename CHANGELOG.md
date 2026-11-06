# Histórico de versões — Extensão Dark com IA

Formato inspirado em Keep a Changelog; datas omitidas (repositório pessoal).

## [4.3.3] — sem travar: varredura guiada por mutações e flush espaçado

### Corrigido
- **Travamento no chat.pradoapp.com** (SPAs grandes em geral): três
  gargalos do motor por elemento, expostos quando a v4.3.2 passou a
  cobrir a página inteira (antes o teto de 8000 jogava a página no
  filtro — rápido, mas feio):
  1. **Reconsulta completa do DOM**: a cada mutação (chats React mutam
     sem parar), o re-scan reconsultava `querySelectorAll("*")` da
     página inteira (~20 mil nós) a cada 1,5s. Agora o
     `MutationObserver` alimenta a fila da varredura **direto** com os
     nós novos e seus descendentes — custo O(novos), não O(página).
  2. **Recalques de estilo em rajada**: cada lote de regras entrava no
     `<style>` na hora; cada flush custa um recálculo de estilo da
     página inteira. Agora as regras acumulam num buffer e entram com
     **≥ 400 ms de intervalo** (primeiro lote, fim da varredura e
     guarda de hover furam o intervalo — reveal e hover continuam
     instantâneos).
  3. **Guarda de hover em cada mousemove**: `mouseover` dispara dezenas
     de eventos por segundo e cada check custava `getComputedStyle`
     no elemento + `::before` + `::after`. Agora cada elemento é
     rechecado **no máximo a cada 1,5s** (`WeakMap`).
- `content.js`: reanálise de SPA com **limiar adaptativo** — em páginas
  gigantes (12 mil nós), ~120 mutações em vez de 40 abrem nova extração
  de features (a extração custa 400 `getComputedStyle` + recálculo ao
  religar os `<style>` da extensão). Detecção de troca de tema (YouTube
  etc.) segue intacta.

### Observado
- A inferência da rede é microssegundos (floresta GBDT minúscula) — o
  custo era todo da varredura de estilo, não da IA.
- Suite: **89 testes** (+6 de fila por mutações e contrato
  anti-travamento de flush/guarda).

## [4.3.2] — bolinha de presença viva e cobertura total em chats gigantes

### Corrigido
- **Acentos apagados** (bolinha de online, badges): o motor por elemento
  tratava cores vivas como "fundo claro" e as escurecia — o verde de
  presença virava um verde apagado. Elementos minúsculos (≤ 14px) com cor
  clara e saturada agora **mantêm a cor original**: a cor viva é o sinal
  visual (`element.js`, regra pura testada). A guarda de interação
  respeita o acento: hover na bolinha não congela um fundo escurecido.
- **Chats gigantes meio remapeados** (visão de conversa do Rocket.Chat,
  chat.pradoapp.com): a página passa de 8000 elementos — o teto do motor —
  e ficava com a casca escura mas balões/campo de digitação/painéis claros
  vazando (o pior estado possível). Teto elevado para **30000 elementos**;
  o `<style>` do motor agora recebe só o delta de regras (flush
  incremental), senão reescrever MBs por lote viraria quadrático.
- **Oscilação motor↔filtro**: ao estourar o teto, o motor caía no filtro,
  o re-scan de SPA re-entrava no motor, estourava de novo e a página
  piscava entre os dois estados sem parar. O fallback agora é **lacrado**
  até a próxima navegação (`engineFellBack` no `content.js`).

### Observado
- Diagnóstico com dataLog real exportado da visão de conversa: a decisão
  da IA já estava correta (inverter com motor por elemento, p = 1.0 —
  família CHAT_HYBRID); o defeito era do **motor**, não do modelo. Sem
  retreino, sem mudança de pesos — o dataset de reprodução segue intacto.
- Suite: **83 testes** (+9 de acentos vivos, teto do motor e guarda).

## [4.3.1] — rotulador desambigua híbridos pelo conteúdo

### Alterado
- `tools/load-real-data.js`: páginas na zona cinza da **aparência** (hero
  colorido, muitas mídias — o meanLum do screenshot mente) agora são
  rotuladas pelo **conteúdo** medido por elemento: elementos claros + texto
  escuro → inverter (casos reais: threads, vimeo, booking, americanas,
  gov.br, w3schools, zoom, nature, python.org); elementos escuros + texto
  claro → não mexer (steam, shopify, roblox, chess.com). Ainda ambíguo →
  descartado, como antes — a regra continua conservadora.
- Dataset real no treino: 91 → **104 páginas** (93 claras, 11 escuras);
  `weights-page.js` retreinado (52.750 bytes). Ganho medido no dataset:
  chess.com 0,50 (na fronteira) → **0,14** sem mexer; híbridos claros
  decidem inverter com p ≥ 0,99.
- Suite: **74 testes** (+3 do rotulador de híbridos).

### Adicionado
- CI: `crawl-real` agora roda em **2 fatias paralelas** (60 sites cada) +
  job que mescla, commita o dataset e publica o artefato. Cada fatia fica
  em ~20 min, longe do shutdown externo de ~40 min que matou duas coletas
  seguidas (exit 143, com o commit do dataset pulado). Fatia que falha não
  derruba a coleta: o job de registro mescla o que houver (best effort).

## [4.3.0] — retreino com dataset real: a IA aprende com a web de verdade

### Alterado
- **Primeiro retreino do modelo de páginas com dados reais**: o job `crawl-real`
  coletou os 120 sites de `tools/dev/sites.txt` (119 páginas sem erro de rede) e
  o rotulador perceptual (`tools/load-real-data.js`) aproveitou **91 páginas**
  — 84 claras e 7 escuras; híbridos, páginas em branco e paywalls ficam de
  fora de propósito (rótulo sem confiança não entra no treino). Cada página
  real vale por 8 sintéticas no treino; holdout e gates continuam sintéticos
  e determinísticos para comparar versões entre si.
- `weights-page.js` regravado pela floresta GBDT: holdout **100%** (MSE
  0,00026 ≤ 0,001), casos-chave **PRADO 1,00**, **TELEGRAM_DARK 0,00** e
  **ROCKET 1,00**, 15 arquétipos OK — mesma régua das versões anteriores.
- Dataset real versionado em `tools/dev/data/report-*.json` (commit de volta
  pelo próprio CI): retreino fica reproduzível em qualquer máquina.

### Adicionado
- 4 testes do rotulador de dados reais (clara/escura rotuladas, blank e híbrido
  descartados): suite em **71 testes**.

## [4.2.1] — coleta de dados reais ampliada (infra)

### Adicionado
- `tools/dev/sites.txt` de 12 para **120 sites reais** selecionados do ranking
  público Majestic Million com deduplicação por marca e curadoria manual
  (sem infra/redirect/APIs): redes sociais, portais, e-commerce, docs/dev,
  governo, universidades, ciência e um bloco Brasil (Globo, UOL, Mercado
  Livre, Magazine Luiza etc.). Variedade de estilo vale mais que rank bruto.
- Gatilho `[crawl]`: commit com essa tag na mensagem dispara o job
  `crawl-real` na hora, além do semanal — a coleta deixa de esperar a
  segunda-feira quando a lista muda.

## [4.2.0] — guarda de interação: hover/foco em tempo real

### Corrigido
- Hover/foco clareando a página (caso real: `chat.pradoapp.com` — "quando passa
  o mouse fica branco, não dá de ler"). A varredura estática do motor por
  elemento lê o estilo computado **em repouso**; regras de interação
  (`:hover`, `:focus`, `:active`), overlays em pseudo-elementos
  (`::before`/`::after`) e cores via `var()` só existem no instante da
  interação. Elemento transparente em repouso não recebia regra nenhuma, então
  o "hover branco" do tema claro original aplicava por cima — com o texto já
  claro, virava faixa ilegível.
- Nova **guarda de interação** no `element.js`: listeners delegados de
  `mouseover`/`focusin` (capture, passive) no documento; quando o elemento sob
  o ponteiro (e até 4 ancestrais) ESTÁ claro naquele instante — fundo,
  gradiente ou pseudo-elemento — o remapeamento escuro é congelado numa regra
  permanente do elemento (`[darl-guard="N"]`). Como lê o valor computado já
  resolvido, cobre também cores via `var()` e estilos inline trocados por JS.
  Texto escuro trazido pela interação clareia com a mesma guarda WCAG AA.

### Adicionado
- Testes da guarda (função pura `guardDecls`): hover claro gera fundo escuro +
  texto claro, hover já escuro não gera regra, gradiente claro de hover escurece
  (67 testes).
- Probe de hover no crawler: `hoverProbe`/`hoverMaxLum` nas `FIXTURE_RULES` —
  o job `visual` passa o mouse de verdade, tira screenshot só do elemento e
  falha se a linha ficar clara. Fixture `hybrid-chat.html` ganhou o
  `:hover` branco típico de tema claro para exercitar a guarda.

## [4.1.0] — caso real Rocket.Chat: arquétipo CHAT_HYBRID a partir do dataLog

### Corrigido
- Chat híbrido com casca escura (caso real: `chat.pradoapp.com`, Rocket.Chat,
  exportado pelo "Exportar dados de navegação" do popup). A página tem body
  escuro e o conteúdo é um painel branco sobreposto: nas features por elemento
  ela parece "site escuro" (94%+ dos elementos herdam o fundo escuro), então a
  IA dizia "retoque escuro" com 95% de confiança e o centro do chat ficava
  branco. Assinatura que separa esse caso de um site escuro de verdade: texto
  de luminância média com contraste medido péssimo (`lowContrast` ~0.96) —
  num tema escuro real o texto é claro e o contraste medido é bom.
- Arquétipo `CHAT_HYBRID` (`tools/page-dataset.js`) calibrado no vetor REAL
  exportado, rótulo inverter com o motor por elemento (a sidebar escura fica
  escura, o painel branco escurece, o texto escuro clareia com guarda WCAG).
  Gate novo no treinador: `ROCKET conf ≥ 0.75` (antes p(inverter)=0.06, agora
  conf 1.00). Holdout segue 100% (MSE 0.00022), PRADO 1.00, TELEGRAM_DARK 0.00.
- Teto do motor por elemento: 4000 → 8000 elementos. Chats SPA como o
  Rocket.Chat passam de 4000 nós e cairiam no fallback de filtro global, que
  clareia a sidebar escura.

### Adicionado
- Teste `CHAT_HYBRID` no `tools/test-nn.js` com o vetor real (63 testes).
- Fixture `tools/dev/fixtures/hybrid-chat.html` + regra no crawler: reproduz
  a assinatura real (fracWithBg ~0.06, fracDark ~0.97, lowContrast ~0.98) e o
  job `visual` do CI guarda o caso para sempre — o painel central tem de
  escurecer com a sidebar escura intacta.

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
