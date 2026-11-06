# Arquitetura — Extensão Dark com IA

Este documento descreve como a extensão funciona por dentro. Para as regras de
trabalho no repositório, veja [AGENTS.md](AGENTS.md).

## Visão geral

```
carregamento da página (document_start)
 ├─ boot cover anti-flash (html.darl-boot, tampa escura, ≤450ms)
 ├─ cache do host (última decisão da IA) → tema provisório imediato
 └─ DOM pronto → extração de 32 features
      → REDE 1 (páginas, 32→32→24→6)
           ├─ decide: inverter | retoque escuro | não mexer
           ├─ knobs: brilho, contraste, sépia, dim, tint
           ├─ site já escuro? pula (ou retoque, se forceTheme) 
           └─ respeita: forced-colors, <meta darkreader-lock>
      → se inverteu:
           ├─ REDE 3 (regiões, 8→12→1) neutraliza blocos escuros grandes (dd-region)
           └─ REDE 2 (imagens, 6→12→1) decide cada <img> (dd-keep)
      → buildCSS (modo CSS clássico ou SVG Filter+) → estilo aplicado → reveal
```

As três redes são MLPs em JS puro, executadas por `nn.js` (`DarlNN`), com pesos
embutidos nos arquivos `weights-*.js` (incluindo a **temperatura calibrada** de cada
rede). A extensão é **inference-only**: todo treino é offline (ver
[tools/nnlab.js](tools/nnlab.js)).

## As três redes

### Rede 1 — páginas (32 → 32 → 24, tanh → 6, sigmoid)

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
de limiar nunca muda.

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

## Motores de cor (`buildCSS`)

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
  `smartImages`, `forceTheme`, `svgFilter` (schema migrado no `onInstalled`).
- `chrome.storage.local` — `hostCache`: última decisão da IA por host (≤300 hosts),
  usada como tema provisório anti-flash. Pesos **não** são persistidos: são
  embutidos (v2.0.0 inference-only).

## Fluxos auxiliares

- **Anti-flash**: tampa escura em `document_start` (`html.darl-boot` esconde os
  filhos do `<html>` por até 450ms — `<html>` pinta o escuro). Cache do host
  aplica tema na hora; análise real assume e revela. Timeout de segurança
  inexorável revela sempre, mesmo em erro.
- **SPAs**: `MutationObserver` com throttle (≥40 mutações, ≥1 reanálise/5s, pausa
  em aba oculta) reextrai features quando o site troca de tema sem recarregar.
- **Reanalisar**: popup envia `darl-refresh`; inline responde `darl-get-state`.

## Decisões de projeto (e o porquê)

| Decisão | Motivo |
|---|---|
| Filter/invert como base (não dynamic por elemento) | Escopo e performance; mesmos limites conhecidos do modo Filter do Dark Reader |
| Inference-only (v2.0.0) | Reprodutibilidade: comportamento da extensão = função dos pesos versionados no git |
| Treino com arquétipos sintéticos + interpolações na família | Cobre o espaço de páginas com poucos dados; fronteira suave; sem coleta de dados reais |
| Caps WCAG embutidos no mapeamento | Halation: texto branco puro em fundo escuro cansa; branco→#19, texto→#ddd |
| Respeitar `darkreader-lock` | Convenção do ecossistema; sites podem pedir exclusão |
| `forced-colors`/print inume | Acessibilidade primeiro |

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
