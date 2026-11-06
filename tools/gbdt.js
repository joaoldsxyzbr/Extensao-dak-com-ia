// Gradient boosting puro (multi-saida) para dados tabulares — Extensão Dark com IA.
// Nenhuma dependencia: arvores de regressao CART com boosting em JS puro,
// para treinar o modelo de paginas com os mesmos datasets do pipeline nnlab
// (arquetipos sinteticos hoje, dados reais do crawler amanha).
//
// Arvore multi-saida: cada folha guarda um VETOR de 6 valores (uma por saida
// do modelo), e o ganho de divisao soma a reducao de variancia de todas as
// saidas. Inference: soma das folhas x taxa de aprendizado — O(profundidade x
// rodadas) por pagina, sem biblioteca e sem build.
"use strict";

function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// ------------------------------------------------------------------ arvore

// constroi uma arvore sobre residuos. data = { X: Float64Array[]-like, y: vec[] }
// ids = indices das amostras deste no. Retorna nos em arrays paralelas:
// feat[], thresh[], left[], right[] (-1 = folha), leaf[] (vetor ou null).
function buildTree(X, Y, ids, opts, rng) {
  const nOut = opts.nOut;
  const maxDepth = opts.maxDepth || 4;
  const minLeaf = opts.minLeaf || 10;
  const colSample = opts.colSample || 6;
  const nFeat = opts.nFeat;

  const feat = [], thresh = [], left = [], right = [], leaf = [];

  function meanVec(list) {
    const m = new Array(nOut).fill(0);
    for (const i of list) {
      const v = Y[i];
      for (let o = 0; o < nOut; o++) m[o] += v[o];
    }
    for (let o = 0; o < nOut; o++) m[o] /= list.length;
    return m;
  }

  function split(list, depth) {
    const node = feat.length;
    if (depth >= maxDepth || list.length < minLeaf * 2) {
      feat.push(-1); thresh.push(0); left.push(-1); right.push(-1); leaf.push(meanVec(list));
      return node;
    }
    const n = list.length;
    // somas prefixas por saida para cortes O(1)
    const totS = new Array(nOut).fill(0), totSq = new Array(nOut).fill(0);
    for (const i of list) {
      const v = Y[i];
      for (let o = 0; o < nOut; o++) { totS[o] += v[o]; totSq[o] += v[o] * v[o]; }
    }
    let sseTot = 0;
    for (let o = 0; o < nOut; o++) sseTot += totSq[o] - (totS[o] * totS[o]) / n;
    let best = null;
    const featIdxs = [];
    const pool = [];
    for (let f = 0; f < nFeat; f++) pool.push(f);
    const k = Math.min(colSample, nFeat);
    for (let i = 0; i < k; i++) featIdxs.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);

    for (const f of featIdxs) {
      const sorted = list.slice().sort((a, b) => X[a][f] - X[b][f]);
      const xs = sorted.map((i) => X[i][f]);
      // prefixos: cumS[p]/cumSq[p] = somas dos primeiros p+1 elementos
      const cumS = [], cumSq = [];
      {
        const s = new Array(nOut).fill(0), sq = new Array(nOut).fill(0);
        for (let p = 0; p < n; p++) {
          const v = Y[sorted[p]];
          for (let o = 0; o < nOut; o++) { s[o] += v[o]; sq[o] += v[o] * v[o]; }
          cumS.push(s.slice()); cumSq.push(sq.slice());
        }
      }
      for (let p = minLeaf; p <= n - minLeaf; p++) {
        if (xs[p] === xs[p - 1]) continue; // sem limiar distinto aqui
        let gain = sseTot;
        for (let o = 0; o < nOut; o++) {
          const sl = cumS[p - 1][o], sql = cumSq[p - 1][o];
          const sr = totS[o] - sl, sqr = totSq[o] - sql;
          gain -= sql - (sl * sl) / p;
          gain -= sqr - (sr * sr) / (n - p);
        }
        if (!best || gain > best.gain) {
          best = { gain, f, thresh: (xs[p] + xs[p - 1]) / 2, cut: p };
        }
      }
    }
    if (!best || best.gain <= 1e-9) {
      feat.push(-1); thresh.push(0); left.push(-1); right.push(-1); leaf.push(meanVec(list));
      return node;
    }
    const sorted = list.slice().sort((a, b) => X[a][best.f] - X[b][best.f]);
    const L = sorted.slice(0, best.cut);
    const R = sorted.slice(best.cut);
    feat.push(best.f); thresh.push(best.thresh); left.push(-1); right.push(-1); leaf.push(null);
    const lChild = split(L, depth + 1);
    const rChild = split(R, depth + 1);
    left[node] = lChild;
    right[node] = rChild;
    return node;
  }

  split(ids, 0);
  return { feat, thresh, left, right, leaf };
}

function predictTree(tree, x) {
  let n = 0;
  while (tree.left[n] !== -1) {
    n = x[tree.feat[n]] <= tree.thresh[n] ? tree.left[n] : tree.right[n];
  }
  return tree.leaf[n];
}

// ----------------------------------------------------------------- boosting

// Treina GBDT multi-saida. data = [{x: number[], y: number[]}], valData igual.
// Retorna { lr, trees, base, predict(x), valMse }.
function train(data, valData, opts) {
  const nOut = opts.nOut;
  const lr = opts.lr || 0.1;
  const rounds = opts.rounds || 120;
  const seed = opts.seed || 7;
  const rng = makeRng(seed);
  const nFeat = data[0].x.length;

  const X = data.map((d) => d.x);
  const Y = data.map((d) => d.y);
  const base = new Array(nOut).fill(0);
  for (let o = 0; o < nOut; o++) {
    let s = 0;
    for (const d of data) s += d.y[o];
    base[o] = s / data.length;
  }

  // predicoes correntes
  const pred = data.map(() => base.slice());
  const predVal = valData.map(() => base.slice());
  const trees = [];
  let bestVal = Infinity;
  let bestTrees = null;
  let bestRound = 0;

  for (let r = 0; r < rounds; r++) {
    // residuos (identidade como link)
    const resY = data.map((d, i) => d.y.map((v, o) => v - pred[i][o]));
    const ids = data.map((_, i) => i);
    const tree = buildTree(X, resY, ids, { ...opts, nFeat, nOut }, rng);
    trees.push(tree);
    for (let i = 0; i < data.length; i++) {
      const leaf = predictTree(tree, X[i]);
      for (let o = 0; o < nOut; o++) pred[i][o] += lr * leaf[o];
    }
    for (let i = 0; i < valData.length; i++) {
      const leaf = predictTree(tree, valData[i].x);
      for (let o = 0; o < nOut; o++) predVal[i][o] += lr * leaf[o];
    }
    // perda de validacao (MSE medio por saida)
    let mse = 0;
    for (let i = 0; i < valData.length; i++) {
      for (let o = 0; o < nOut; o++) {
        const e = valData[i].y[o] - predVal[i][o];
        mse += e * e;
      }
    }
    mse /= valData.length * nOut;
    if (mse < bestVal - 1e-7) { bestVal = mse; bestTrees = trees.length; }
    if (opts.log && ((r + 1) % opts.logEvery === 0 || r === rounds - 1)) {
      console.log(`    rodada ${r + 1}/${rounds}  val MSE=${mse.toFixed(5)}`);
    }
  }

  // corta no melhor round (early stopping simples)
  const kept = trees.slice(0, bestTrees);

  function predict(x) {
    const out = base.slice();
    for (const t of kept) {
      const leaf = predictTree(t, x);
      for (let o = 0; o < nOut; o++) out[o] += lr * leaf[o];
    }
    return out.map((v) => Math.min(1, Math.max(0, v)));
  }

  return { lr, base, trees: kept, predict, valMse: bestVal, bestRound: bestTrees };
}

// ------------------------------------------------------------- serializacao

// Formato compacto para o weights-page.js: arvores como arrays planas.
function serialize(model) {
  return {
    kind: "gbdt",
    lr: model.lr,
    base: model.base.map((v) => Math.round(v * 1e5) / 1e5),
    nOut: model.base.length,
    trees: model.trees.map((t) => ({
      f: t.feat, t: t.thresh.map((v) => Math.round(v * 1e5) / 1e5),
      l: t.left, r: t.right,
      v: t.leaf.map((v) => (v ? v.map((x) => Math.round(x * 1e5) / 1e5) : null)),
    })),
  };
}

function loadForest(w) {
  const trees = w.trees.map((t) => ({ feat: t.f, thresh: t.t, left: t.l, right: t.r, leaf: t.v }));
  return {
    predict(x) {
      const out = w.base.slice();
      for (const tr of trees) {
        let n = 0;
        while (tr.left[n] !== -1) n = x[tr.feat[n]] <= tr.thresh[n] ? tr.left[n] : tr.right[n];
        const leaf = tr.leaf[n];
        for (let o = 0; o < w.nOut; o++) out[o] += w.lr * leaf[o];
      }
      return out.map((v) => Math.min(1, Math.max(0, v)));
    },
  };
}

module.exports = { train, serialize, loadForest, predictTree, buildTree, makeRng };
