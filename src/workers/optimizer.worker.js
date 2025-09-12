// src/workers/optimizer.worker.js
/* eslint-env worker, es2020 */
import { optimizeRoundRobinTargets } from "../lib/optimizerCore.js";

globalThis.onmessage = (e) => {
  const { cores, gems, role, weights, perCoreLimit } = e.data;
  const result = optimizeRoundRobinTargets(cores, gems, role, weights, perCoreLimit);
  globalThis.postMessage(result);
};
