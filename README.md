# Darl Dark

Extensão Chrome (Manifest V3) de modo escuro dirigida por mini redes neurais que rodam
inteiramente dentro da extensão, sem servidor nem bibliotecas.

## Como funciona

```
página carrega → content.js extrai 32 features (histograma de luminância, frações
  escura/clara, contraste do texto, saturação vívida, fontes mono/título/pequenas,
  position fixed, marcadores semânticos: article nav table form mídia...)
→ rede de páginas (32 → 24 → 16 → 6) em nn.js
→ decisões: inverter / retoque escuro / não mexer + brilho, contraste, sépia, dim, tint
→ CSS filter aplicado
feedback no popup → backpropagation → pesos salvos → todas as abas se atualizam
```

- Sites claros: a rede inverte as cores (imagens e vídeos voltam ao original).
- Imagens: a segunda rede (6→12→1) decodifica cada `<img>` num canvas 16×16 e decide
  por imagem entre restaurar as cores originais (fotos, logos) ou manter invertida
  (ícones escuros com transparência ficam claros e visíveis no fundo escuro).
  Imagens opacas voltam ao original mesmo quando muito escuras.
- Sites já escuros: por padrão a extensão aplica um retoque de uniformização
  (`forceTheme: true`), em vez de respeitar o tema do site sem fazer nada.
- O feedback do usuário ("ficou claro demais" / "escuro demais") realiza 30 passos
  de gradiente sobre os pesos e propaga a mudança para todas as abas abertas.
- O modelo v2 entende seis arquétipos de página e saídas contínuas: site claro comum,
  página branca dura (docs), notícias creme, site já escuro, dashboard escuro
  saturado e páginas mistas — com dim e tint calibrados por arquétipo.
- Só a IA decide: não existe ajuste manual por site — a rede (e o seu feedback
  treinando-a) define tudo. Há apenas chaves globais (forçar tema, análise de
  imagens, restaurar mídias) e o interruptor geral.
- `chrome.storage.local.hostCache` memoriza a última decisão por host: nas revisitas,
  o tema é aplicado na hora (anti-flash) e a rede refina depois.
- SPAs (YouTube, Reddit): `MutationObserver` com throttle reanalisa a página quando
  o site troca de tema sem recarregar.

## Arquivos

| Arquivo | Papel |
|---|---|
| `manifest.json` | Manifest V3; permissões mínimas (`storage`, `activeTab`) |
| `content.js` | Features, decisão, aplicação do CSS, cache anti-flash |
| `nn.js` | Motor MLP genérico: forward + backpropagation (ambas as redes) |
| `weights-page.js` | Pesos da rede de páginas v2 (gerado pelo treinador) |
| `weights-images.js` | Pesos da rede de imagens |
| `popup.html/css/js` | Controles, análise e feedback (treino da rede) |
| `background.js` | Atalho Alt+Shift+D e migração de schema no `onInstalled` |
| `tools/train-page-model.js` | Treinador do modelo de páginas (regenera `weights-page.js`) |
| `tools/generate_icons.py` | Gera os ícones PNG (sem dependências) |
| `tools/test-nn.js` | Testes das redes e do ciclo de feedback |

## Instalar (desenvolvedor)

1. Abra `chrome://extensions`
2. Ative o **Modo do desenvolvedor**
3. **Carregar sem compactação** e selecione esta pasta

## Testar os modelos

```
node tools/test-nn.js        # valida as duas redes e o ciclo de feedback
node tools/train-page-model.js  # retreina a rede de páginas e regera weights-page.js
```

Cobre inferência nos três regimes (clara/escura/mista), o ciclo de feedback
(backprop com os mesmos parâmetros do popup), serialização e tamanho dos pesos.

## Limitações conhecidas

- Modo filter global (igual ao "Filter mode" do Dark Reader): elementos com
  `position: fixed` podem acompanhar o scroll.
- Pode haver um breve flash claro no carregamento antes da primeira análise.
- A validação visual em sites reais é manual; o resto é coberto por `tools/test-nn.js`.
