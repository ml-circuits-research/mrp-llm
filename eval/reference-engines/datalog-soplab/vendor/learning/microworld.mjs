// VENDORED: copied verbatim from soplab-v0.4.0.zip src/learning/microworld.mjs
import { atom } from '../model.mjs';

export function seededRandom(seed = 1) {
  let x = seed >>> 0;
  return () => {
    x += 0x6D2B79F5;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makePathWorld({ seed = 1, relationA = 'a', relationB = 'b', target = 'target', positives = 6, distractors = 18, labelNoise = 0 } = {}) {
  const rnd = seededRandom(seed);
  const facts = [], pos = [], neg = [];
  const nodes = Array.from({ length: Math.max(20, positives * 4) }, (_, i) => `n${seed}_${i}`);
  for (let i = 0; i < positives; i++) {
    const x = nodes[i * 3], z = nodes[i * 3 + 1], y = nodes[i * 3 + 2];
    facts.push(atom(relationA, x, z), atom(relationB, z, y));
    pos.push([x, y]);
  }
  for (let i = 0; i < distractors; i++) {
    const x = nodes[Math.floor(rnd() * nodes.length)], y = nodes[Math.floor(rnd() * nodes.length)];
    facts.push(atom(rnd() < 0.5 ? relationA : relationB, x, y));
  }
  for (let i = 0; i < positives * 2; i++) {
    const x = nodes[Math.floor(rnd() * nodes.length)], y = nodes[Math.floor(rnd() * nodes.length)];
    if (!pos.some(([a, b]) => a === x && b === y)) neg.push([x, y]);
  }
  if (labelNoise > 0) {
    const flip = (arr1, arr2) => {
      for (let i = arr1.length - 1; i >= 0; i--) if (rnd() < labelNoise) arr2.push(arr1.splice(i, 1)[0]);
    };
    flip(pos, neg); flip(neg, pos);
  }
  return { facts, positives: pos, negatives: neg, target };
}

export function makeWorlds({ count = 3, seed = 1, ...options } = {}) {
  return Array.from({ length: count }, (_, i) => makePathWorld({ ...options, seed: seed + i * 101 }));
}
