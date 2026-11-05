"use strict";

// Motores das mini redes neurais da extensao Darl Dark.
//
// Rede da pagina (weights-page.js -> DARL_PAGE_WEIGHTS):
//   MLP 32 -> 24 (tanh) -> 16 (tanh) -> 6 (sigmoid)
//   Saidas: [inverter, brilho, contraste, sepia, dim, tint]
// Rede de imagens (weights-images.js -> DARL_IMAGE_WEIGHTS):
//   MLP 6 -> 12 (tanh) -> 1 (sigmoid): manter invertida ou restaurar.
//
// Formato de pesos (default e storage): { dims: number[], W: Mat[], b: Vec[] }

(function () {
  const sigmoid = (v) => 1 / (1 + Math.exp(-v));

  // dims = [d0, d1, ..., dn]; camadas ocultas tanh, saida sigmoid.
  function makeNet(dims, weights, random) {
    const net = { dims: dims.map(Number) };
    if (weights) {
      net.W = weights.W.map((m) => m.map((row) => row.slice()));
      net.b = weights.b.map((v) => v.slice());
    } else {
      const rf = random || (() => Math.random() * 2 - 1);
      net.W = [];
      net.b = [];
      for (let l = 0; l < dims.length - 1; l++) {
        net.W.push(
          Array.from({ length: dims[l + 1] }, () =>
            Array.from({ length: dims[l] }, () => rf() * 0.4)
          )
        );
        net.b.push(new Array(dims[l + 1]).fill(0));
      }
    }
    return net;
  }

  function compatible(weights, dims) {
    return Boolean(
      weights && weights.dims && weights.W && weights.b &&
      weights.dims.length === dims.length &&
      dims.every((d, i) => weights.dims[i] === d)
    );
  }

  function forward(net, x) {
    let a = x.slice();
    const acts = [a];
    for (let l = 0; l < net.W.length; l++) {
      const last = l === net.W.length - 1;
      a = net.W[l].map((row, i) => {
        let z = net.b[l][i];
        for (let j = 0; j < row.length; j++) z += row[j] * a[j];
        return last ? sigmoid(z) : Math.tanh(z);
      });
      acts.push(a);
    }
    return { acts, p: a };
  }

  // Um passo de SGD com retropropagacao (MSE). Ocultas tanh, saida sigmoid.
  function train(net, x, y, lr) {
    const { acts, p } = forward(net, x);
    let loss = 0;
    for (let o = 0; o < p.length; o++) loss += (p[o] - y[o]) * (p[o] - y[o]);
    loss /= p.length;

    let delta = p.map((po, o) => (po - y[o]) * po * (1 - po));
    for (let l = net.W.length - 1; l >= 0; l--) {
      const aPrev = acts[l];
      for (let i = 0; i < net.W[l].length; i++) {
        const row = net.W[l][i];
        for (let j = 0; j < row.length; j++) row[j] -= lr * delta[i] * aPrev[j];
        net.b[l][i] -= lr * delta[i];
      }
      if (l > 0) {
        const aThis = acts[l];
        const dp = new Array(aThis.length).fill(0);
        for (let i = 0; i < delta.length; i++) {
          const row = net.W[l][i];
          for (let j = 0; j < row.length; j++) dp[j] += row[j] * delta[i];
        }
        for (let j = 0; j < aThis.length; j++) dp[j] *= 1 - aThis[j] * aThis[j];
        delta = dp;
      }
    }
    return loss;
  }

  // Arredonda para 5 casas: pesos compactos no storage.
  function serialize(net) {
    const r5 = (v) => Math.round(v * 1e5) / 1e5;
    return {
      dims: net.dims.slice(),
      W: net.W.map((m) => m.map((row) => row.map(r5))),
      b: net.b.map((v) => v.map(r5)),
    };
  }

  globalThis.DarlNN = { makeNet, compatible, forward, train, serialize };
})();
