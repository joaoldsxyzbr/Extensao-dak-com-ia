// Laboratorio de treino compartilhado (Darl Dark). Uso: node.
// Pipeline moderno para MLPs pequenas:
//   Adam (Kingma & Ba, com bias correction) + mini-batches
//   + cosine decay da taxa de aprendizado (Loshchilov & Hutter)
//   + weight decay (L2 no passo do Adam)
//   + split holdout, early stopping com checkpoint do melhor modelo
//   + calibracao de temperatura (Guo et al. 2017) para confianca honesta.
"use strict";

// ---------------------------------------------------------------- utilidades

function xorshift(seed) {
  let s = seed >>> 0;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967295;
  };
}

function deepClone(net) {
  return {
    dims: net.dims.slice(),
    W: net.W.map((m) => m.map((r) => r.slice())),
    b: net.b.map((v) => v.slice()),
  };
}

const sigmoid = (v) => 1 / (1 + Math.exp(-v));

// ---------------------------------------------------------------- rede

// Glorot/Xavier: inicializacao padrao hoje para tanh.
function createNet(dims, random) {
  const net = { dims: dims.slice(), W: [], b: [] };
  for (let l = 0; l < dims.length - 1; l++) {
    const scale = Math.sqrt(2 / (dims[l] + dims[l + 1]));
    net.W.push(
      Array.from({ length: dims[l + 1] }, () =>
        Array.from({ length: dims[l] }, () => (random() * 2 - 1) * scale)
      )
    );
    net.b.push(new Array(dims[l + 1]).fill(0));
  }
  return net;
}

function forward(net, x) {
  let a = x;
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

// Gradientes de MSE: camadas ocultas tanh, saida sigmoid.
function lossGrads(net, x, y) {
  const { acts, p } = forward(net, x);
  let loss = 0;
  for (let o = 0; o < p.length; o++) loss += (p[o] - y[o]) * (p[o] - y[o]);
  loss /= p.length;

  const gW = net.W.map((m) => m.map((r) => r.map(() => 0)));
  const gb = net.b.map((v) => v.map(() => 0));

  let delta = p.map((po, o) => (po - y[o]) * po * (1 - po));
  for (let l = net.W.length - 1; l >= 0; l--) {
    const aPrev = acts[l];
    for (let i = 0; i < net.W[l].length; i++) {
      const row = net.W[l][i];
      for (let j = 0; j < row.length; j++) gW[l][i][j] += delta[i] * aPrev[j];
      gb[l][i] += delta[i];
    }
    if (l > 0) {
      const aThis = acts[l];
      const dPrev = new Array(aThis.length).fill(0);
      for (let i = 0; i < delta.length; i++) {
        const row = net.W[l][i];
        for (let j = 0; j < row.length; j++) dPrev[j] += row[j] * delta[i];
      }
      for (let j = 0; j < aThis.length; j++) dPrev[j] *= 1 - aThis[j] * aThis[j];
      delta = dPrev;
    }
  }
  return { loss, gW, gb };
}

// ---------------------------------------------------------------- Adam

function createAdam(net) {
  return {
    mW: net.W.map((m) => m.map((r) => r.map(() => 0))),
    vW: net.W.map((m) => m.map((r) => r.map(() => 0))),
    mb: net.b.map((v) => v.map(() => 0)),
    vb: net.b.map((v) => v.map(() => 0)),
    t: 0,
  };
}

// Passo Adam com weight decay acoplado (AdamL2 clasico).
function adamStep(net, state, gW, gb, lr, wd, beta1 = 0.9, beta2 = 0.999, eps = 1e-8) {
  state.t++;
  const b1c = 1 - Math.pow(beta1, state.t);
  const b2c = 1 - Math.pow(beta2, state.t);
  for (let l = 0; l < net.W.length; l++) {
    for (let i = 0; i < net.W[l].length; i++) {
      const row = net.W[l][i];
      for (let j = 0; j < row.length; j++) {
        const g = gW[l][i][j] + wd * row[j];
        state.mW[l][i][j] = beta1 * state.mW[l][i][j] + (1 - beta1) * g;
        state.vW[l][i][j] = beta2 * state.vW[l][i][j] + (1 - beta2) * g * g;
        row[j] -= (lr * (state.mW[l][i][j] / b1c)) / (Math.sqrt(state.vW[l][i][j] / b2c) + eps);
      }
      const g = gb[l][i];
      state.mb[l][i] = beta1 * state.mb[l][i] + (1 - beta1) * g;
      state.vb[l][i] = beta2 * state.vb[l][i] + (1 - beta2) * g * g;
      net.b[l][i] -= (lr * (state.mb[l][i] / b1c)) / (Math.sqrt(state.vb[l][i] / b2c) + eps);
    }
  }
}

// ---------------------------------------------------------------- treino

function evalMse(net, data) {
  if (!data.length) return 0;
  let total = 0;
  for (const s of data) total += forward(net, s.x).p.reduce((acc, v, i) => acc + (v - s.y[i]) * (v - s.y[i]), 0) / s.y.length;
  return total / data.length;
}

// Agendamento cosine com warmup curto.
function cosineLr(step, totalSteps, lrMax, lrMin) {
  const warmup = Math.min(0.05, 20 / totalSteps);
  if (step / totalSteps < warmup) return lrMax * (step / totalSteps / warmup);
  const t = (step / totalSteps - warmup) / (1 - warmup);
  return lrMin + 0.5 * (lrMax - lrMin) * (1 + Math.cos(Math.PI * Math.min(t, 1)));
}

// opts: { epochs, batchSize, lrMax, lrMin, weightDecay, patience, log }
// Retorna { net (melhor checkpoint por validacao), history, bestValLoss }
function trainNet(net, trainData, valData, opts) {
  const random = opts.random || xorshift(42);
  net = deepClone(net);
  const state = createAdam(net);
  const totalSteps = opts.epochs * Math.max(1, Math.ceil(trainData.length / (opts.batchSize || 32)));
  let step = 0;
  let best = { net: deepClone(net), val: evalMse(net, valData) };
  let sinceBest = 0;

  for (let epoch = 0; epoch < opts.epochs; epoch++) {
    const order = trainData.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const bs = opts.batchSize || 32;
    for (let start = 0; start < order.length; start += bs) {
      const gW = net.W.map((m) => m.map((r) => r.map(() => 0)));
      const gb = net.b.map((v) => v.map(() => 0));
      let batchLoss = 0;
      const batch = order.slice(start, start + bs);
      for (const idx of batch) {
        const { loss, gW: pgw, gb: pgb } = lossGrads(net, trainData[idx].x, trainData[idx].y);
        batchLoss += loss;
        for (let l = 0; l < gW.length; l++) {
          for (let i = 0; i < gW[l].length; i++) {
            for (let j = 0; j < gW[l][i].length; j++) gW[l][i][j] += pgw[l][i][j];
            gb[l][i] += pgb[l][i];
          }
        }
      }
      const inv = 1 / batch.length;
      for (let l = 0; l < gW.length; l++) {
        for (let i = 0; i < gW[l].length; i++) {
          for (let j = 0; j < gW[l][i].length; j++) gW[l][i][j] *= inv;
          gb[l][i] *= inv;
        }
      }
      const lr = cosineLr(step, totalSteps, opts.lrMax || 0.01, opts.lrMin || opts.lrMax / 100 || 0.0001);
      adamStep(net, state, gW, gb, lr, opts.weightDecay || 0);
      step++;
    }
    const val = evalMse(net, valData);
    if (val < best.val - 1e-6) {
      best = { net: deepClone(net), val };
      sinceBest = 0;
    } else {
      sinceBest++;
    }
    if (opts.log && (epoch === 0 || (epoch + 1) % opts.logEvery === 0)) {
      console.log(`  epoca ${epoch + 1}/${opts.epochs}: train=${evalMse(net, trainData).toFixed(5)} val=${val.toFixed(5)} (melhor=${best.val.toFixed(5)})`);
    }
    if ((opts.patience || 80) <= sinceBest) {
      if (opts.log) console.log(`  early stop na epoca ${epoch + 1}`);
      break;
    }
  }
  return { net: best.net, bestValLoss: best.val };
}

// ---------------------------------------------------------------- calibracao

// Temperatura T que minimiza NLL da saida binaria idx (busca em grade refina).
// T>1: confianca menos confiavel (confianca honesta); T<1: mais confiante.
function fitTemperature(net, data, idx) {
  const logits = [];
  for (const s of data) {
    const p = forward(net, s.x).p[idx];
    const z = Math.log(Math.max(p, 1e-6) / Math.max(1 - p, 1e-6));
    logits.push({ z, y: s.y[idx] });
  }
  function nll(T) {
    let total = 0;
    for (const { z, y } of logits) {
      const p = 1 / (1 + Math.exp(-z / T));
      total += -(y * Math.log(Math.max(p, 1e-9)) + (1 - y) * Math.log(Math.max(1 - p, 1e-9)));
    }
    return total / logits.length;
  }
  // Range limitado: T extremos (<0.1) so aparecem com dados sinteticos
  // perfeitamente separaveis e exageram a confianca em dados reais.
  let lo = 0.1, hi = 3;
  for (let i = 0; i < 60; i++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (nll(m1) < nll(m2)) hi = m2; else lo = m1;
  }
  return Math.round((lo + hi) / 2 * 1000) / 1000;
}

function serializeNet(net, temp) {
  const r5 = (v) => Math.round(v * 1e5) / 1e5;
  return {
    dims: net.dims.slice(),
    W: net.W.map((m) => m.map((row) => row.map(r5))),
    b: net.b.map((v) => v.map(r5)),
    temp: temp === undefined ? 1 : temp,
  };
}

function saveWeightsFile(destPath, header, weights) {
  const fs = require("fs");
  const out = header + JSON.stringify(weights) + ";\n";
  fs.writeFileSync(destPath, out);
  return out.length;
}

module.exports = {
  xorshift, createNet, forward, trainNet, evalMse, fitTemperature,
  serializeNet, saveWeightsFile, deepClone,
};
