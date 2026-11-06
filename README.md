# Darl Dark

Extensão Chrome (Manifest V3) de modo escuro dirigida por mini redes neurais que rodam
inteiramente dentro da extensão, sem servidor nem bibliotecas.

## Como funciona

```
página carrega (com tampa escura anti-flash desde o document_start)
→ content.js extrai 32 features (histograma de luminância, frações
  escura/clara, contraste do texto, saturação vívida, fontes mono/título/pequenas,
  position fixed, marcadores semânticos: article nav table form mídia...)
→ rede de páginas (32 → 24 → 16 → 6) em nn.js
→ decisões: inverter / retoque escuro / não mexer + brilho, contraste, sépia, dim, tint
→ em páginas invertidas: rede de regiões (8 → 12 → 1) neutraliza a inversão em
  blocos escuros grandes (header, footer, hero, card de código)
→ rede de imagens (6 → 12 → 1) decide por imagem restaurar ou manter invertida
→ conteúdo revelado já com o tema aplicado (boot cover com timeout de segurança)
treino offline (tools/train-*.js, pipeline nnlab: Adam, cosine LR, weight decay,
  holdout, early stopping, calibração de temperatura) → pesos embutidos na extensão
```

- Sites claros: a rede inverte as cores (imagens e vídeos voltam ao original).
- Imagens: a segunda rede (6→12→1) decodifica cada `<img>` num canvas 16×16 e decide
  por imagem entre restaurar as cores originais (fotos, logos) ou manter invertida
  (ícones escuros com transparência ficam claros e visíveis no fundo escuro).
  Imagens opacas voltam ao original mesmo quando muito escuras.
- Sites já escuros: por padrão a extensão aplica um retoque de uniformização
  (`forceTheme: true`), em vez de respeitar o tema do site sem fazer nada.
- Treino 100% offline: a extensão é inference-only. Os pesos das três redes são
  gerados pelos treinadores (validados em holdout, com temperatura calibrada),
  embarcados em `weights-*.js` e apenas executados no navegador.
- O modelo v2 entende seis arquétipos de página e saídas contínuas: site claro comum,
  página branca dura (docs), notícias creme, site já escuro, dashboard escuro
  saturado e páginas mistas — com dim e tint calibrados por arquétipo.
- Só a IA decide: não existe ajuste manual por site. Há apenas chaves globais
  (forçar tema, análise de imagens, restaurar mídias, modo SVG) e o interruptor
  geral. A "confiança 98%" do popup é calibrada por temperatura (Guo et al. 2017)
  minimizada no holdout — a porcentagem significa o que diz.
- `chrome.storage.local.hostCache` memoriza a última decisão por host: nas revisitas,
  o tema é aplicado na hora (anti-flash) e a rede refina depois.
- SPAs (YouTube, Reddit): `MutationObserver` com throttle reanalisa a página quando
  o site troca de tema sem recarregar.

## Arquivos

| Arquivo | Papel |
|---|---|
| `manifest.json` | Manifest V3; permissões mínimas (`storage`, `activeTab`) |
| `content.js` | Features, decisão, aplicação do CSS, cache anti-flash |
| `nn.js` | Motor MLP genérico: forward + backpropagation (as três redes) |
| `weights-page.js` | Pesos da rede de páginas v2 (gerado pelo treinador) |
| `weights-images.js` | Pesos da rede de imagens |
| `weights-region.js` | Pesos da rede de regiões (gerado pelo treinador) |
| `popup.html/css/js` | Controles e análise (somente leitura das decisões da IA) |
| `background.js` | Atalho Alt+Shift+D e migração de schema no `onInstalled` |
| `tools/nnlab.js` | Laboratório compartilhado: Adam, mini-batch, cosine LR, weight decay, holdout, early stopping, calibração |
| `tools/train-page-model.js` | Treinador da rede de páginas (regenera `weights-page.js`) |
| `tools/train-region-model.js` | Treinador da rede de regiões (regenera `weights-region.js`) |
| `tools/train-image-model.js` | Treinador da rede de imagens (regenera `weights-images.js`) |
| `tools/generate_icons.py` | Gera os ícones PNG (sem dependências) |
| `tools/test-nn.js` | Testes das três redes, matrizes SVG e calibração |

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
