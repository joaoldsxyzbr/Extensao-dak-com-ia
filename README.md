# Extensão Dark com IA

Extensão Chrome (Manifest V3) de modo escuro dirigida por mini redes neurais que rodam
inteiramente dentro da extensão, sem servidor nem bibliotecas.

## Como funciona

```
página carrega (com tampa escura anti-flash desde o document_start)
→ darl-features.js extrai 32 features (histograma de luminância, frações
  escura/clara, contraste do texto, saturação vívida, fontes mono/título/pequenas,
  position fixed, marcadores semânticos: article nav table form mídia...)
→ modelo de páginas em nn.js: floresta GBDT (v4; antes MLP) decide
  inverter / retoque escuro / não mexer
→ site claro: motor por elemento (element.js) lê o estilo computado de CADA
  elemento e remapeia cor por cor — fundos claros escurecem mantendo o matiz,
  textos escuros clareiam com guarda WCAG 4.5:1, bordas, sombras e gradientes
  junto; páginas híbridas ficam certas porque cada região é tratada de acordo
  com a própria cor original
→ páginas grandes demais ou erro na varredura: fallback automático para o modo
  filtro clássico (invert + hue-rotate), com rede de regiões (8 → 12 → 1)
  neutralizando blocos escuros grandes
→ rede de imagens (6 → 12 → 1) decide por imagem: no modo por elemento, ícones
  escuros transparentes viram claros (inversão local), fotos seguem originais
→ conteúdo revelado já com o tema aplicado (boot cover com timeout de segurança)
treino offline (tools/train-page-gbdt.js para a floresta; pipeline nnlab para
  imagens/regiões) → pesos embutidos na extensão
```

- Sites claros: o motor por elemento remapeia as cores uma a uma, sem filtro
  global de inversão (imagens e vídeos ficam com as cores originais).
- Imagens: a segunda rede (6→12→1) decodifica cada `<img>` num canvas 16×16 e decide
  por imagem entre restaurar as cores originais (fotos, logos) ou manter invertida
  (ícones escuros com transparência ficam claros e visíveis no fundo escuro).
  Imagens opacas voltam ao original mesmo quando muito escuras.
- Sites já escuros: por padrão a extensão aplica um retoque de uniformização
  (`forceTheme: true`), em vez de respeitar o tema do site sem fazer nada.
- Treino 100% offline: a extensão é inference-only. Os pesos das três redes são
  gerados pelos treinadores (validados em holdout, com temperatura calibrada),
  embarcados em `weights-*.js` e apenas executados no navegador.
- O modelo v3 entende 14 arquétipos de página e saídas contínuas: site claro
  comum, página branca dura (docs), notícias creme, páginas mistas, app de
  mensagens híbrido (painel escuro + chat claro), e-commerce, buscador
  minimalista, feed social, longa-leitura, galeria de mídia, site escuro
  bruto, dashboard escuro saturado, tema escuro bem desenhado (Telegram/
  Discord/GitHub dark) e AMOLED preto puro — com dim e tint por arquétipo.
- Só a IA decide: não existe ajuste manual por site. Há apenas chaves globais
  (análise por elemento, forçar tema, análise de imagens, restaurar mídias,
  modo SVG) e o interruptor geral. A "confiança 98%" do popup é calibrada por
  temperatura (Guo et al. 2017) minimizada no holdout — a porcentagem significa
  o que diz.
- Dados reais para o retreino: a extensão registra localmente as features e a
  decisão de cada página vista (host + 32 features + saída da IA, sem
  querystring) e o popup exporta um JSON ("Exportar dados de navegação").
  Nada sai do navegador sem esse clique. O crawler de regressão visual
  (`tools/dev/`) complementa com screenshots e métricas perceptuais no CI.
- `chrome.storage.local.hostCache` memoriza a última decisão por host: nas revisitas,
  o tema é aplicado na hora (anti-flash) e a rede refina depois.
- SPAs (YouTube, Reddit): `MutationObserver` com throttle reanalisa a página quando
  o site troca de tema sem recarregar.

## Arquivos

| Arquivo | Papel |
|---|---|
| `manifest.json` | Manifest V3; permissões mínimas (`storage`, `activeTab`, `downloads`) |
| `darl-features.js` | Extração das 32 features (compartilhada com o crawler) |
| `element.js` | Motor de análise por elemento: remapeia cor por cor (v4) |
| `content.js` | Decisão, aplicação do tema, cache anti-flash, registro de dados |
| `nn.js` | Motores: MLP + floresta GBDT (despachante `DarlModel`) e matrizes SVG |
| `weights-page.js` | Modelo de páginas: floresta GBDT (gerado por `train-page-gbdt.js`) |
| `weights-images.js` | Pesos da rede de imagens |
| `weights-region.js` | Pesos da rede de regiões (gerado pelo treinador) |
| `popup.html/css/js` | Controles, análise e exportação de dados (somente leitura das decisões da IA) |
| `background.js` | Atalho Alt+Shift+D, migração de schema e download do JSON exportado |
| `tools/page-dataset.js` | Fonte única dos 14 arquétipos e do gerador de datasets |
| `tools/gbdt.js` | Gradient boosting puro (árvores CART multi-saída em JS) |
| `tools/train-page-gbdt.js` | Treinador da floresta de páginas (regenera `weights-page.js`) |
| `tools/train-page-model.js` | Treinador MLP alternativo (registro histórico do duelo) |
| `tools/train-region-model.js` | Treinador da rede de regiões (regenera `weights-region.js`) |
| `tools/train-image-model.js` | Treinador da rede de imagens (regenera `weights-images.js`) |
| `tools/generate_icons.py` | Gera os ícones PNG (sem dependências) |
| `tools/test-nn.js` | Testes das três redes, floresta, motor por elemento e calibração |
| `tools/dev/` | Crawler Playwright + métricas perceptuais (regressão visual no CI; deps só aqui) |

## Documentação

| Documento | Para quem |
|---|---|
| [AGENTS.md](AGENTS.md) | Agentes de código (e humanos) trabalhando no repositório: regras de ouro, comandos, como ajustar a IA |
| [ARCHITECTURE.md](ARCHITECTURE.md) | O detalhado: features, mapeamentos, motores de cor, fluxos e decisões de projeto |
| [CHANGELOG.md](CHANGELOG.md) | Histórico completo das versões |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Fluxo de contribuição e report de páginas problemáticas |

## Instalar (desenvolvedor)

1. Abra `chrome://extensions`
2. Ative o **Modo do desenvolvedor**
3. **Carregar sem compactação** e selecione esta pasta

## Testar os modelos

```
node tools/test-nn.js             # valida as três redes, matrizes e calibração
node tools/train-page-model.js    # retreina a rede de páginas e regera weights-page.js
node tools/train-region-model.js  # retreina a rede de regiões e regera weights-region.js
node tools/train-image-model.js   # retreina a rede de imagens e regera weights-images.js
```

Cobre os arquétipos das três redes, o mapeamento WCAG anti-halation, as matrizes
SVG (Filter+), a calibração de temperatura e a guarda de compatibilidade de pesos.

## Limitações conhecidas

- **Anti-flash**: o `document_start` instala uma tampa escura (`html.darl-boot`) e
  o conteúdo só é revelado com o tema aplicado — com timeout de segurança de 450ms
  e preferência pelo cache do host, então revisitas revelam quase instantaneamente.
- **Mapeamento WCAG**: o contraste invertido é limitado a 0.90 e há piso leve de
  dessaturação — o branco vira ~#191919 (não #000) e o texto ~#ddd (não #fff),
  evitando halation (texto branco puro cansa em fundo escuro). Testado em
  `tools/test-nn.js`.
- **Meta-lock**: sites com `<meta name="darkreader-lock">` são respeitados
  (convenção do ecossistema Dark Reader).
- **Acessibilidade**: `forced-colors` do sistema desativa a intervenção, e o tema
  nunca é aplicado na impressão (`@media print`).
- **Modo SVG (Filter+)**: experimental, opção "Cores mais fiéis" — a cadeia
  inteira (sepia, grayscale, inversão, brilho, contraste) vira uma única
  `feColorMatrix` com `invertNHue`, que inverte a luminância **preservando o
  matiz** (azuis continuam azuis). Mídias e regiões são restauradas pelo reverso
  exato — a mesma matriz involutiva.
- Modo filter global: elementos com `position: fixed` ainda podem acompanhar o
  scroll quando a região que os contém é neutralizada (efeito raro).
- A validação visual em sites reais é manual; o resto é coberto por `tools/test-nn.js`.
