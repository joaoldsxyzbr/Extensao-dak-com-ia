# Contribuindo com o Darl Dark

Projeto sem dependências: preciso apenas de Node.js (para treino/testes) e,
opcionalmente, Python 3 (para regerar ícones). A extensão carrega via
"Carregar sem compactação" em `chrome://extensions`.

## Regras básicas

Leia [AGENTS.md](AGENTS.md) — vale para humanos também. Resumo executivo:

- Arquivos `weights-*.js` são gerados por `tools/train-*.js`. Nunca edite à mão.
- `node tools/test-nn.js` verde antes de commit; `node --check` em cada JS tocado.
- Sem dependências novas, sem build step, sem treino dentro da extensão.
- Comentários e UI em pt-BR.

## Fluxo: mudar como a IA trata páginas

O comportamento das redes vem dos **arquétipos** (dados do professor) nos
treinadores — não de regras de código. Todo ajuste de comportamento segue o mesmo
ciclo:

```
1. edite o arquétipo em tools/train-page-model.js (ou região/imagem)
2. node tools/train-page-model.js     → treina, valida em holdout, regera pesos
3. node tools/test-nn.js              → suite de regressão
4. recarregue a extensão no navegador e confira visualmente
5. commit: treinador + pesos regenerados + (se aplicável) teste atualizado
```

O treinador **se recusa a gravar pesos** se: algum caso-chave falhar, ou o acerto
em holdout ficar abaixo de 99.5%. Se isso acontecer, o problema está no professor
(dados) ou na expectativa (teste) — nunca "force" os pesos.

## Reportando páginas problemáticas

Bug visual = futuro arquétipo. Ao reportar, inclua:

1. URL da página (ou descrição do tipo de site);
2. Sintoma: dupla inversão? claro demais? ícone invisível? header virou branco?
3. O que o popup mostra (confiança, chips — invert/retoque, brilho etc.).

Cada relato vira um arquétipo/`vary` no treinador e, quando possível, um teste
em `tools/test-nn.js` que fixa a expectativa para sempre.

## Quer expandir as capacidades (features novas)?

- Nova feature de página: siga "Como adicionar uma feature de página" em
  [AGENTS.md](AGENTS.md) — três pontos de sincronia (treinador, extrator, teste)
  e retreino.
- As fronteiras atuais do projeto (o que é factível localmente, o que exigiria
  modo dinâmico por elemento) estão discutidas em [ARCHITECTURE.md](ARCHITECTURE.md)..
