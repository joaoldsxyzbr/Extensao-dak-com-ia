# Contribuindo com a Extensão Dark com IA

Projeto sem dependências no runtime: preciso apenas de Node.js (para
treino/testes) e, opcionalmente, Python 3 (para regerar ícones). A extensão
carrega via "Carregar sem compactação" em `chrome://extensions`. A única
dependência do projeto é o Playwright do crawler de regressão visual
(`tools/dev/`), usado apenas em desenvolvimento e no CI — nunca carregado
pela extensão.

## Regras básicas

Leia [AGENTS.md](AGENTS.md) — vale para humanos também. Resumo executivo:

- Arquivos `weights-*.js` são gerados (`tools/train-page-gbdt.js --write`
  para a floresta de páginas, `tools/train-*.js` para as MLPs). Nunca edite
  à mão.
- `node tools/test-nn.js` verde antes de commit; `node --check` em cada JS tocado.
- Sem dependências novas no runtime, sem build step, sem treino dentro da extensão.
- Comentários e UI em pt-BR.

## Fluxo: mudar como a IA trata páginas

O comportamento das redes vem dos **arquétipos** (dados do professor) — não
de regras de código. Todo ajuste de comportamento segue o mesmo ciclo:

```
1. edite o arquétipo em tools/page-dataset.js (ou treinador de região/imagem)
2. node tools/train-page-gbdt.js --write  → treina, valida em holdout, regera pesos
3. node tools/test-nn.js                  → suite de regressão
4. recarregue a extensão no navegador e confira visualmente
5. commit: dataset + pesos regenerados + (se aplicável) teste atualizado
```

O treinador **se recusa a gravar pesos** se: algum caso-chave falhar, ou o
acerto em holdout ficar abaixo de 99.5%. Se isso acontecer, o problema está
no professor (dados) ou na expectativa (teste) — nunca "force" os pesos.

## Reportando páginas problemáticas

Bug visual = futuro arquétipo. Ao reportar, inclua:

1. URL da página (ou descrição do tipo de site);
2. Sintoma: dupla inversão? claro demais? ícone invisível? header virou branco?
3. O que o popup mostra (confiança, chips — invert/retoque, brilho, motor).

A partir da v4, dá para exportar os dados das últimas páginas navegadas:
popup → "Exportar dados de navegação" baixa um JSON com host + features +
decisão da IA para cada página registrada. Anexe junto do relato.

Cada relato vira um arquétipo/`vary` no dataset e, quando possível, um teste
em `tools/test-nn.js` ou um fixture em `tools/dev/fixtures/` (regressão
visual no CI) que fixa a expectativa para sempre.

## Quer expandir as capacidades (features novas)?

- Nova feature de página: siga "Como adicionar uma feature de página" em
  [AGENTS.md](AGENTS.md) — três pontos de sincronia (dataset, extrator em
  `darl-features.js`, teste) e retreino.
- O modo dinâmico por elemento existe desde a v4 (`element.js`) — melhorias
  de mapeamento de cores, seleção de elementos e fallback entram ali; a
  discussão de fronteiras e decisões de projeto está em
  [ARCHITECTURE.md](ARCHITECTURE.md).
