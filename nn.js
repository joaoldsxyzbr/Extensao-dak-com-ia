"use strict";

// Motores das mini redes neurais da Extensão Dark com IA.
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

  // Escala de temperatura (Guo et al.): deixa a confianca exibida honesta.
  // T>1 amolece, T<1 aguca. Monotonica: a decisao de limiar nao muda.
  function calibrate(p, temp) {
    if (!temp || temp === 1) return p;
    const t = Math.max(0.1, Math.min(3, temp));
    const a = Math.pow(Math.max(p, 1e-6), 1 / t);
    const b = Math.pow(Math.max(1 - p, 1e-6), 1 / t);
    return a / (a + b);
  }

  globalThis.DarlNN = { makeNet, compatible, forward, train, serialize, calibrate };

  // ------------------------------------------------- motor de matrizes (modo SVG)
  // Compoem a cadeia sepia x grayscale x contraste x brilho x invertNHue numa
  // unica matriz 5x5, no mesmo formato feColorMatrix do Dark Reader Filter+.
  // invertNHue inverte a luminancia preservando o matiz - cores mais fiéis que
  // invert(1) hue-rotate(180deg).

  const M = {
    identity: () => [[1,0,0,0,0],[0,1,0,0,0],[0,0,1,0,0],[0,0,0,1,0],[0,0,0,0,1]],
    invertNHue: () => [
      [0.333, -0.667, -0.667, 0, 1],
      [-0.667, 0.333, -0.667, 0, 1],
      [-0.667, -0.667, 0.333, 0, 1],
      [0, 0, 0, 1, 0],
      [0, 0, 0, 0, 1],
    ],
    brightness: (v) => [[v,0,0,0,0],[0,v,0,0,0],[0,0,v,0,0],[0,0,0,1,0],[0,0,0,0,1]],
    contrast: (v) => {
      const t = (1 - v) / 2;
      return [[v,0,0,0,t],[0,v,0,0,t],[0,0,v,0,t],[0,0,0,1,0],[0,0,0,0,1]];
    },
    sepia: (v) => [
      [0.393 + 0.607 * (1 - v), 0.769 - 0.769 * (1 - v), 0.189 - 0.189 * (1 - v), 0, 0],
      [0.349 - 0.349 * (1 - v), 0.686 + 0.314 * (1 - v), 0.168 - 0.168 * (1 - v), 0, 0],
      [0.272 - 0.272 * (1 - v), 0.534 - 0.534 * (1 - v), 0.131 + 0.869 * (1 - v), 0, 0],
      [0, 0, 0, 1, 0],
      [0, 0, 0, 0, 1],
    ],
    grayscale: (v) => [
      [0.2126 + 0.7874 * (1 - v), 0.7152 - 0.7152 * (1 - v), 0.0722 - 0.0722 * (1 - v), 0, 0],
      [0.2126 - 0.2126 * (1 - v), 0.7152 + 0.2848 * (1 - v), 0.0722 - 0.0722 * (1 - v), 0, 0],
      [0.2126 - 0.2126 * (1 - v), 0.7152 - 0.7152 * (1 - v), 0.0722 + 0.9278 * (1 - v), 0, 0],
      [0, 0, 0, 1, 0],
      [0, 0, 0, 0, 1],
    ],
  };

  function multiplyMatrices(a, b) {
    const out = [];
    for (let i = 0; i < a.length; i++) {
      out.push([]);
      for (let j = 0; j < b[0].length; j++) {
        let sum = 0;
        for (let k = 0; k < a[0].length; k++) sum += a[i][k] * b[k][j];
        out[i].push(sum);
      }
    }
    return out;
  }

  // chain: { sepia, grayscale, contrast, brightness } em escala 0..1.
  // Ordem espelha o modo CSS: sepia/grayscale antes da inversao;
  // brightness/contrast DEPOIS (o que permite o lift anti-halation no preto).
  function composeDarkMatrix(chain) {
    let m = M.identity();
    if (chain.sepia > 0) m = multiplyMatrices(m, M.sepia(chain.sepia));
    if (chain.grayscale > 0) m = multiplyMatrices(m, M.grayscale(chain.grayscale));
    m = multiplyMatrices(m, M.invertNHue());
    if (chain.brightness !== 1) m = multiplyMatrices(m, M.brightness(chain.brightness));
    if (chain.contrast !== 1) m = multiplyMatrices(m, M.contrast(chain.contrast));
    return m;
  }

  function toSVGMatrixString(matrix) {
    return matrix.slice(0, 4).map((row) => row.map((v) => v.toFixed(3)).join(" ")).join(" ");
  }

  function applyColorMatrix(rgb, matrix) {
    const [r, g, b] = rgb;
    const v = [r / 255, g / 255, b / 255, 1, 1];
    return [0, 1, 2].map((i) => {
      let sum = 0;
      for (let k = 0; k < 5; k++) sum += matrix[i][k] * v[k];
      return Math.min(255, Math.max(0, Math.round(sum * 255)));
    });
  }

  globalThis.DarlMatrix = { invertNHue: M.invertNHue, composeDarkMatrix, toSVGMatrixString, applyColorMatrix, multiplyMatrices };
})();
