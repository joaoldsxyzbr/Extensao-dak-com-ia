# Arquitetura — Extensão Dark com IA

Este documento descreve como a extensão funciona por dentro. Para as regras de
trabalho no repositório, veja [AGENTS.md](AGENTS.md).

## Visão geral

```
carregamento da página (document_start)
 ├─ boot cover anti-flash (html.darl-boot, tampa escura, ≤450ms)
 ├─ cache do host (última decisão da IA) → tema provisório imediato
 └─ DOM pronto → extração de 32 features (darl-features.js)
      → MODELO 1 (páginas): floresta GBDT multi-saída (DarlModel, nn.js)
           ├─ decide: inverter | retoque escuro | não mexer
           ├─ knobs (só nos modos filtro/retoque): brilho, contraste, sépia, dim, tint
           ├─ site já escuro? pula (ou retoque, se forceTheme)
           └─ respeita: forced-colors, <meta darkreader-lock>
      → se inverteu, motor por elemento (element.js, v4, padrão):
           ├─ varre o DOM em lotes via requestIdleCallback
           ├─ fundo claro → escurece (matiz preservado); texto escuro → clareia
           │  com guarda WCAG 4.5:1; bordas, sombras e gradientes idem
           ├─ base: html escuro + color-scheme: dark (controles nativos escuros)
           ├─ frames about:blank/srcdoc: motor de frames do documento topo (v4.3.4)
           ├─ REDE 2 (imagens, 6→12→1): ícones escuros ganham inversão local (dd-keep)
           └─ página grande demais ou erro → fallback para o modo filtro clássico:
                REDE 3 (regiões, 8→12→1) neutraliza blocos escuros (dd-region)
      → se retoque/filtro: buildCSS (CSS clássico ou SVG Filter+) → reveal
```

As redes são MLPs em JS puro executadas por `nn.js` (`DarlNN`); o modelo de
páginas v4 é uma **floresta GBDT** (árvores de regressão multi-saída, também
JS puro) abstraída pelo despachante `DarlModel`. Os pesos ficam embutidos nos
arquivos `weights-*.js` (incluindo a **temperatura calibrada** de cada modelo).
A extensão é **inference-only**: todo treino é offline (ver
[tools/nnlab.js](tools/nnlab.js) e [tools/gbdt.js](tools/gbdt.js)).

## Os modelos

### Modelo 1 — páginas (floresta GBDT multi-saída, 6 saídas)

Entradas (ordem canônica, idêntica ao treinador e aos testes):

| # | Feature | # | Feature |
|---|---|---|---|
| 0 | luminância do fundo html/body | 16 | saturação média dos fundos |
| 1 | luminância média efetiva | 17 | fração de fundos muito saturados |
| 2-9 | histograma de luminância (8 faixas) | 18 | fração de fundos "coloridos" |
| 10 | fração de elementos com fundo próprio | 19 | fração de imagens |
| 11 | fração de elementos escuros (lum<0.25) | 20 | fração de background-image inline |
| 12 | fração de elementos claros (lum>0.75) | 21 | fração de fontes mono (código) |
| 13 | luminância média do texto | 22 | tamanho médio de fonte (norm.) |
| 14 | fração de texto com contraste < 3:1 | 23 | fração de títulos (≥24px) |
| 15 | contraste médio texto/fundo (log norm.) | 24 | fração de UI pequena (≤12px) |
| | | 25 | fração de position fixed/sticky |
| | | 26-30 | contagens log-norm.: article, nav, table, form/mídia |
| | | 31 | site declara esquema dark (meta) |

Saídas e mapeamentos (definidos em `content.js`/treinador — precisam coincidir):

```
saidas: [inverter, brilho(b), contraste(c), sépia(s), dim(d), tint(t)]

inverter = TRUE  (página clara):      inverter = FALSE (retoque, site escuro):
  brilho    = 0.6 + 0.8*b                brilho    = 0.7 + 0.3*d
  contraste = 0.6 + 0.8*c (cap 0.90)*    contraste = 0.9 + 0.25*c
  sépia     = 0.5*s                     sépia     = 0.5*s
  tint      = 0.25*t (piso 0.03)*        tint      = 0.25*t (piso 0.03)*

* limites WCAG embutidos: anti-halation (branco→~#191919, texto→~#ddd).
```

A confiança exibida no popup é `DarlNN.calibrate(p0, T)` com T calibrada no holdout
do treino (minimização de NLL, Guo et al. 2017). Calibração é monótona: a decisão
de limiar nunca muda. Na floresta, a saída 0 é clipada para (0.001, 0.999), o
logit é recalibrado por T e volta à probabilidade.

Treinada por `tools/train-page-gbdt.js` (80 rodadas, profundidade 3, lr 0.12,
colSample 8, holdout ≥ 99.5%, casos-chave PRADO/TELEGRAM_DARK obrigatórios).
No duelo local contra a MLP v3, a floresta venceu: MSE 0.00019 vs 0.00116,
confiança do caso PRADO 1.00 vs 0.97 — e árvores são o formato natural para
engolir os dados reais do crawler sem retrabalho. Desde a v4.3.0 o treino soma
páginas reais do `crawl-real` (`tools/dev/data/report-*.json`, auto-rotuladas
por `tools/load-real-data.js` com peso 8 cada); desde a v4.3.5 o rótulo é
decidido pelo **conteúdo medido por elemento ANTES da aparência do
screenshot** (o screenshot mente: hero escuro/colorido arrasta o `meanLum`,
tema em cookie escurece o que o crawler limpo renderiza claro): conteúdo
claro (`fracLight` ≥ 0,85) inverte — inclusive página clara atrás de hero
escuro (gitlab/apple/harvard), mesmo com texto claro de hero; casca escura
com texto claro ilegível (`fracDark` ≥ 0,85 + `lowContrast` ≥ 0,50 +
`textLum` ≤ 0,60) é **híbrido** e inverte com motor por elemento
(Rocket.Chat/php.net: a casca fica escura, o painel claro escurece); escuro
de verdade (`fracDark` ≥ 0,85 + `textLum` ≥ 0,60 + `lowContrast` ≤ 0,25 —
texto claro E legível) não mexe; a aparência do screenshot virou fallback e
o que continua ambíguo é descartado. Holdout e gates continuam sintéticos e
determinísticos para comparar versões entre si.

### Rede 2 — imagens (6 → 12 → 1)

Cada `<img>` é decodificada num canvas 16×16 e classificada:
`[fracTransp, lumMédia, lumDesvio, satMédia, fracEscura, fracClara]`.
Saída 1 = **manter invertida** (ícone/logo escuro com transparência — ficaria
invisível se restaurado; permanece invertido e vira claro e visível), 0 =
**restaurar cores originais** (fotos, logos coloridos, qualquer imagem opaca —
mesmo muito escura). Regra aprendida com os dados, não codificada.

Fila assíncrona: lotes de 16 com `requestIdleCallback`, limite de 400 por ciclo,
reclassificação quando o `src` muda, `getImageData` cross-origin sem CORS →
 restaura (nunca quebra).

### Rede 3 — regiões (8 → 12 → 1)

Em páginas **invertidas**, blocos grandes escuros com fundo opaco (≥1.5% da
viewport, lum ≤ 0.5) são candidatos. Features:
`[lum, sat, textLum, contraste, área, éFixed, temBgImg, fracMídiaFilhos]`.
Saída 1 = **manter original** (classe `dd-region` neutraliza a inversão local):
headers fixos, footers, heros com imagem, cards de código escuros. Saída 0 =
seguir a inversão (painéis cinzas intermediários, conteúdo claro).

## Motores de cor

**Motor por elemento** (`elementMode: true`, padrão desde a v4): em vez de um
filtro global, `element.js` lê o estilo computado de cada nó do DOM e remapeia
cor por cor com regras de luminância — fundo claro vira escuro preservando o
matiz (branco → ~#1b1b1b, nunca preto puro), texto escuro vira claro com guarda
de contraste WCAG AA (≥ 4.5:1 contra o fundo mapeado), bordas/sombras/gradientes
são remapeadas junto, `fill`/`stroke` de SVG também. Elementos ganham o atributo
`darl-el` e regras `!important` num `<style>` próprio (flush incremental:
só o delta entra no DOM, e **throttled** — ≥ 400 ms entre flushes, v4.3.3:
cada flush custa um recálculo de estilo da página inteira; primeiro lote,
fim da varredura e guarda de hover furam o intervalo). A varredura é
incremental: página inteira **uma vez** no load e, a partir daí, fila
alimentada pelo `MutationObserver` (v4.3.3 — nós novos e seus
descendentes entram direto na fila; antes o re-scan reconsultava o DOM
inteiro a cada 1.5s e travava SPAs que mutam sem parar, como chats React);
lotes de ~120 via `requestIdleCallback`, teto de 30000 elementos — v4.3.2:
a visão de conversa do Rocket.Chat passa de 8000 e ficava metade remapeada.
Fotos e vídeos ficam intactos por construção —
não existe inversão global para reverter. `color-scheme: dark` no `<html>` escurece
controles nativos e barras de rolagem. Acima do teto ou em erro: fallback
automático para o modo filtro, **lacrado** até a próxima navegação (`engineFellBack`
no `content.js`): sem o lacre, o re-scan de SPA re-entrava no motor, estourava o
teto de novo e a página oscilava entre meio-remapeada e invertida. **Acentos
vivos** (v4.3.2): elementos minusculos (≤ 14px) com cor clara e saturada
(bolinha de presença, badge) mantêm a cor original — a cor viva é o sinal
visual; o remapeamento normal os apagaria. É o motor que resolve páginas híbridas (sidebar
escura + chat claro) sem rede de regiões. Estados de interação (`:hover`,
`:focus`) e pseudo-elementos não existem no estilo computado em repouso: a
**guarda de interação** (v4.2) observa `mouseover`/`focusin` no documento e,
**por elemento no máximo a cada 1.5s** (v4.3.3 — `mousemove` dispara dezenas
de eventos por segundo e cada check custa `getComputedStyle` no elemento e
nos pseudo-elementos), congela o
se o elemento sob o ponteiro estiver claro naquele instante, congela o
remapeamento escuro numa regra permanente (`[darl-guard="N"]`) — cobre cores
via `var()` e estilos inline trocados por JS, pois lê o valor já resolvido.

**Motor de frames same-origin** (v4.3.4, no `content.js`): o MV3 injeta o
content script em frames http(s) (`all_frames`), mas **não** em
`about:blank`/`srcdoc` — editores embutidos e viewers de preview
(Rocket.Chat, Gmail) ficavam painéis brancos no meio do tema escuro. O
documento **topo** estende o motor por elemento para dentro desses frames
via `iframe.contentDocument`: mesma lógica de remapeamento (mapeadores
puros do `DarlElement`, regra de acentos vivos incluída), `getComputedStyle`
do próprio frame, varredura em lotes com `requestIdleCallback`, flush
incremental throttled e `MutationObserver` por frame — a disciplina
anti-travamento da v4.3.3 vale dentro dos frames também. Frames http(s)
não são tocados (têm content script próprio e decidem por si, como
qualquer página). A descoberta acontece no `apply()` do motor por
elemento, em mutações que criam iframes e no evento `load` de cada iframe;
engines de documentos mortos são coletados na passada. O gate visual
prova o caso: a fixture `hybrid-chat.html` tem um preview em
`about:blank` e o probe de frame (`frameProbe`/`frameMaxLum` no crawler)
falha se a prévia ficar clara.

**Modo CSS clássico** (padrão): `filter: invert(1) hue-rotate(180deg) brightness()
contrast() sepia() grayscale()` no `<html>`, com fundo opaco branco (transparente
não inverte) e reverter em mídias/`[style*="url("]`.

**Modo SVG Filter+** (`svgFilter: true`, experimental): a cadeia inteira —
sépia × grayscale × `invertNHue` × brilho × contraste — é compilada numa única
`feColorMatrix` 5×5 (`utils` do Dark Reader como base matemática). `invertNHue`
inverte a luminância **preservando o matiz** (azul continua azul; o
`hue-rotate(180deg)` clássico distorre). Como `invertNHue` é involutiva, ela mesma
serve de **reverso exato** para mídias, ícones e regiões.

Em ambos: `@media print` desliga tudo.

## Persistência

- `chrome.storage.sync` — só chaves de comportamento: `enabled`, `invertMedia`,
  `smartImages`, `forceTheme`, `svgFilter`, `elementMode` (schema migrado no
  `onInstalled`).
- `chrome.storage.local` — `hostCache`: última decisão da IA por host (≤300 hosts),
  usada como tema provisório anti-flash. `dataLog`: registro local e anônimo
  (host + 32 features + decisão, sem querystring, ≤500 páginas) exportável como
  JSON pelo popup via `chrome.downloads` — matéria-prima do retreino com dados
  reais; nada sai do navegador sem o clique do usuário. Pesos **não** são
  persistidos: são embutidos (v2.0.0 inference-only).

## Fluxos auxiliares

- **Anti-flash**: tampa escura em `document_start` (`html.darl-boot` esconde os
  filhos do `<html>` por até 450ms — `<html>` pinta o escuro). Cache do host
  aplica tema na hora; análise real assume e revela. Timeout de segurança
  inexorável revela sempre, mesmo em erro.
- **SPAs**: `MutationObserver` com throttle (≥40 mutações, ≥1 reanálise/5s, pausa
  em aba oculta) reextrai features quando o site troca de tema sem recarregar.
- **Reanalisar**: popup envia `darl-refresh`; inline responde `darl-get-state`.
- **Reportar problema** (v4.3.4): o popup junta host + URL (sem query/hash) +
  as 32 features + a decisão da IA + as configurações da página ativa e o
  `background.js` baixa um JSON único (`darl-report-<host>.json`) via
  `chrome.downloads` — diagnostico em um clique, pronto para virar
  arquétipo/fixture/retreino. Mesma política do dataLog: 100% local e
  opt-in, nada sai do navegador sem o clique.

## Decisões de projeto (e o porquê)

| Decisão | Motivo |
|---|---|
| Motor por elemento como padrão (v4), filtro como fallback | Páginas híbridas ficam certas cor por cor (a lição do Dark Reader); filtro global fica para páginas gigantes e como opção |
| GBDT no lugar da MLP para páginas (v4) | MSE 6× menor no holdout, casos-chave mais decisivos; formato pronto para os dados reais do crawler; inference O(árvores×profundidade), ainda JS puro |
| Inference-only (v2.0.0) | Reprodutibilidade: comportamento da extensão = função dos pesos versionados no git |
| Treino com arquétipos sintéticos + interpolações na família | Cobre o espaço de páginas com poucos dados; fronteira suave |
| Coleta de dados reais opt-in (dataLog + crawler do CI) | O teto dos arquétipos sintéticos é o professor; dados reais (features + screenshots + métricas perceptuais) são o próximo salto — e nada sai do navegador sem export explícito |
| Caps WCAG embutidos no mapeamento | Halation: texto branco puro em fundo escuro cansa; branco→#19, texto→#ddd |
| Respeitar `darkreader-lock` | Convenção do ecossistema; sites podem pedir exclusão |
| `forced-colors`/print inume | Acessibilidade primeiro |

## O teto dos dados reais (medido, não estimado)

O projeto vinha tratando "dados reais do crawler" como o próximo salto. Um
experimento mediu o contrário e vale registrar antes de gastar tempo crawleando
mais.

**Protocolo** (nos 104 registros reais de `tools/dev/data/report-2026-11-06.json`):

- **A)** floresta treinada só com arquétipos sintéticos, avaliada nos 104 reais;
- **B)** floresta treinada com sintéticos + 80% dos reais, avaliada nos 20%
  segurados;
- **C)** 5-fold cross-validation nos 104 reais (cada registro avaliado por um
  modelo que nunca o viu).

**Resultados:**

| Medida | Acerto |
|---|---|
| A) sintético puro nos 104 reais | 96,2% (100/104) |
| B) sintético + 80% reais, nos 20% segurados | 95,2% (20/21) |
| A) o mesmo, sem os reais | 95,2% (20/21) |
| C) 5-fold CV nos reais | 95,2% (99/104) |

**Efeito dos dados reais no holdout real: 0,0 pontos percentuais.** O modelo já
reproduz o que o rótulo diz; somar páginas não move o número porque o gargalo
não é quantidade de dados.

**A causa é o rótulo, não a cobertura.** Diagnóstico dos 5 erros do CV:

| Site | Rótulo | Modelo | `htmlBg` | `fracLight` | `textLum` | Screenshot "antes" |
|---|---|---|---|---|---|---|
| gitlab.com | escuro | claro (0,95) | 0,99 | 0,96 | 0,47 | `meanLum` 0,18 |
| apple.com | escuro | claro (0,92) | 1,00 | 0,98 | 0,54 | `meanLum` 0,16 |
| harvard.edu | escuro | claro (0,77) | 0,96 | 0,95 | 0,89 | `meanLum` 0,23 |
| chess.com | escuro | claro (0,53) | 0,18 | 0,00 | 0,91 | `meanLum` 0,32 |
| who.int | claro | escuro (0,47) | — | — | — | `meanLum` 0,65 |

Nos quatro primeiros, as **features dizem página clara** (`htmlBg` ~1,0,
`fracLight` ~0,96) e o modelo está certo; o rótulo diz "escuro" porque o
`load-real-data.js` decide pela **aparência do screenshot**, e o crawler tira o
screenshot num perfil limpo. O gitlab.com tem tema escuro salvo em cookie: no
navegador do usuário é escuro, no perfil do crawler é claro. O mesmo vale para
apple.com e harvard.edu. O chess.com é o caso inverso do Rocket.Chat — casca
escura (`htmlBg` 0,18, `fracDark` 0,99) com texto claro e conteúdo claro.

**Consequência para o Dark Reader.** As listas do Dark Reader
(`tools/dev/fetch-darkreader-lists.js`) escolhem **o que crawlear**, não o que
treinar — e só ajudam na medida em que o rótulo for confiável:

- `sites-hybrid.txt` (blocos `MATCH` do `detector-hints.config`) é o ganho
  real: são os híbridos que o `load-real-data.js` hoje **descarta** por
  ambiguidade, e o seletor dá um rótulo independente da aparência.
- `sites-dark.txt` só ajuda depois de corrigir a regra de rótulo — senão
  injeta mais registros como os quatro acima.
- `sites-hard-light.txt` é matéria-prima de arquétipos e fixtures, não de
  treino direto.

**Ordem recomendada — status v4.3.5:** (1) ✅ feito na v4.3.5: conteúdo por
elemento antes da aparência — recupera os erros "escuro de aparência"
(gitlab/apple/harvard → claro) e 8 descartados; 5-fold CV mediu 96,2% →
99,1% (111/112, único erro o chess.com borderline); (2) ✅ parcialmente
feito na v4.3.5: híbridos de casca escura rotulados pela assinatura de
features (`fracDark` alto + `lowContrast` alto — Rocket.Chat/php.net);
híbridos que a assinatura não cobre seguem descartados, e o seletor do
`detector-hints` continua sendo o rótulo independente para esses casos;
(3) crawlear as listas em ondas segue pendente (os registros reais entram
com peso 8, e 3 155 sites de uma vez dominariam o professor sintético).

## Limitações conhecidas

- `position: fixed` dentro de região neutralizada pode acompanhar o scroll
  (containing block do filter) — modo filter clássico, documentado pelo próprio
  Dark Reader.
- Filter desativa sub-pixel rendering de texto.
- Backgrounds definidos em CSS de stylesheet (não inline) não são restaurados
  individualmente; blocos grandes são salvos pela rede de regiões.
- Modo SVG não é testado em Firefox.
- A validação é holdout sintético + testes de unidade; **o teste visual em sites
  reais é manual** — problemas viram arquétipos nos treinadores.
