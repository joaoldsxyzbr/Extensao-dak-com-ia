# AGENTS.md — Guia para agentes de código neste repositório

## O que é este projeto

Darl Dark é uma extensão Chrome (Manifest V3) de modo escuro, dirigida por três mini
redes neurais que rodam inteiramente local — JS puro, zero dependências, zero servidor.
Decisão arquitetural da v2.0.0: a extensão é **inference-only**. Todo treino acontece
offline, pelos treinadores em `tools/`; a extensão apenas executa os pesos.

## Regras de ouro (leia antes de tocar em qualquer coisa)

1. **`weights-page.js`, `weights-region.js` e `weights-images.js` são ARQUIVOS GERADOS.**
   Nunca edite à mão. Cada um é regenerado pelo treinador correspondente
   (`node tools/train-*.js`), que só grava se o treino passar nos critérios
   (holdout com acerto ≥ 99.5% e casos-chave sem falha). Os headers dos arquivos
   marcam o gerador.
2. **A extensão não treina no navegador.** É decisão deliberada da v2.0.0. Não
   reintroduza backprop/feedback-treino em popup ou content script.
3. **A ordem das features é canônica** e deve ser idêntica em três lugares:
   `tools/train-page-model.js` (constante `ORDER2`), `content.js` (extrator, com
   índices comentados) e `tools/test-nn.js` (constante `ORDER`). Mudou em um,
   mudou nos três — e a rede de páginas precisa ser retreinada.
4. **Portão de qualidade**: `node tools/test-nn.js` precisa passar antes de commit.
   Para todo arquivo JS alterado, rode `node --check <arquivo>`.
5. **Idioma**: comentários, docs e mensagens de UI em pt-BR. Commit com mensagem
   descritiva (veja `git log` para o estilo).
6. **Sem dependências e sem build step.** JS puro no runtime, Python stdlib nos
   scripts de suporte. Não introduzir bundler, package.json ou libs.

## Comandos

| Comando | Efeito |
|---|---|
| `node tools/test-nn.js` | Suite completa: arquétipos das 3 redes, matriz SVG, calibração, guardas |
| `node tools/train-page-model.js` | Retreina rede de páginas e regenera `weights-page.js` |
| `node tools/train-region-model.js` | Retreina rede de regiões e regenera `weights-region.js` |
| `node tools/train-image-model.js` | Retreina rede de imagens e regenera `weights-images.js` |
| `python tools/generate_icons.py` | Regenera os ícones PNG (ícones são artefatos comitados) |

Testar a extensão: carregar sem compactação em `chrome://extensions`.

## Como ajustar o comportamento da IA

O comportamento das redes é definido pelos **arquétipos** (dados do professor) nos
treinadores. Fluxo para mudar como a IA trata páginas:

1. Edite/adicione o arquétipo em `tools/train-page-model.js` (features por nome,
   alvos em `y`, variação em `vary`).
2. Rode o treinador — ele valida em holdout e nos casos-chave em `tools/test-nn.js`.
   Se os testes codificam uma expectativa que o novo comportamento quebra, decida:
   era expectativa certa (volte o professor) ou estava desatualizada (atualize o
   teste explicitamente no mesmo commit).
3. Os pesos regeneram automaticamente; recarregue a extensão.

Detalhe fino que já pegou dois bugs reais: **interpolações entre arquétipos não
podem sobrescrever alvos especiais** (ex.: o `dim` do DARK é calculado por amostra a
partir do `htmlBg`; misturas com BLUE_DASH interpolam, não sobrescrevem).

## Como adicionar uma feature de página (32 → N)

1. Adicione o nome+índice no `ORDER2` do treinador e no `ORDER` do teste.
2. Implemente a extração em `content.js` (extrator amostra até 400 elementos —
   features precisam ser baratas: `getComputedStyle` já é o custo dominante).
3. Alimente a feature nos arquétipos que a distinguem e retreine.
4. Se as dimensões mudarem, a guarda `DarlNN.compatible` descarta pesos antigos —
   bump de versão no `manifest.json` e nota no `CHANGELOG.md`.

## Invariantes que não podem quebrar

- **Caps WCAG no ramo de inversão** (`content.js`, `computeDecision`): contraste
  limitado a 0.90 e piso de `tint` 0.03. Branco invertido vira ~#191919, não #000
  (anti-halation). Há testes cobrindo os valores.
- **`invertNHue` é involutiva** — é a base do reverso de mídias/regiões no modo SVG.
- **`DarlNN.calibrate` é monótona** e fixa p=0.5 — a decisão de limiar nunca muda
  com temperatura.
- Formato de pesos `{dims, W, b[, temp]}`; a guarda de compatibilidade rejeita
  qualquer coisa fora dele.
- Respeito a acessibilidade: `forced-colors` → não interferir; `@media print` →
  página original; `<meta name="darkreader-lock">` → não mexer.

## Mapa dos arquivos

| Arquivo | Papel | Editável à mão? |
|---|---|---|
| `content.js` | Extração de features, decisão, CSS, anti-flash, regiões, imagens | sim |
| `nn.js` | Motor MLP genérico + `DarlMatrix` (matriz SVG Filter+) | sim |
| `weights-page.js` / `weights-region.js` / `weights-images.js` | Pesos + temperatura calibrada | **NÃO** (gerados) |
| `popup.html/css/js` | Interface: leitura das decisões, chaves globais | sim |
| `background.js` | Atalho Alt+Shift+D, migração de schema no `onInstalled` | sim |
| `tools/nnlab.js` | Laboratório: Adam, mini-batch, cosine LR, weight decay, holdout, early stop, calibração | sim |
| `tools/train-*.js` | Treinadores (professor + geração de pesos) | sim |
| `tools/test-nn.js` | Suite de regressão (35 testes) | sim (expectativas explícitas) |
| `tools/generate_icons.py` | Geração de ícones PNG com supersampling | sim |

Documentação ampla em [ARCHITECTURE.md](ARCHITECTURE.md); histórico em
[CHANGELOG.md](CHANGELOG.md); fluxo de contribuição em [CONTRIBUTING.md](CONTRIBUTING.md).
