// VENDORED: copied from sop-r.zip bench/gen.mjs; only the import of rng points at ./rng.mjs
// Synthetic knowledge base in the style an LLM produces when it compiles many documents:
// a large fact base, a class hierarchy, a location hierarchy, thousands of near-identical ground
// rules (one per class, one per zone), a few general rules, an aggregate, a constraint, and one
// rule written with a bad condition order (the kind of rule that explodes without join ordering).
//
//   node bench/gen.mjs N CLASSES ZONES OUTDIR [SEED]
import { writeFileSync, mkdirSync } from 'node:fs';
import { rng } from './rng.mjs';

export function generate(N, CL, Z, seed = 1) {
  const R = rng(seed);
  const S = Math.max(2, Math.floor(Z / 10)), G = Math.max(2, Math.floor(S / 10));
  const MID = Math.max(2, Math.floor(CL / 10));
  const out = [];
  const w = (s) => out.push(s);
  w('# synthetic KB: ' + JSON.stringify({ N, CL, Z, S, G, MID, seed }));
  // taxonomy
  w('@taxonomy fact');
  for (let m = 0; m < MID; m++) w(`  say m${m} subclass-of asset`);
  for (let c = 0; c < CL; c++) w(`  say c${c} subclass-of m${c % MID}`);
  // location hierarchy
  w('@sites fact');
  for (let z = 0; z < Z; z++) w(`  say z${z} located-in s${z % S}`);
  for (let s = 0; s < S; s++) w(`  say s${s} located-in g${s % G}`);
  for (let g = 0; g < G; g++) w(`  say g${g} is-a region`);
  // entities (one frame per 1000 entities keeps the wire count realistic)
  for (let i = 0; i < N; i++) {
    if (i % 1000 === 0) w(`@assets-${i / 1000} fact`);
    w(`  say e${i} is-a c${Math.floor(R.next() * CL)}`);
    w(`  say e${i} in-zone z${Math.floor(R.next() * Z)}`);
    w(`  say e${i} load ${R.next() < 0.05 ? 80 + Math.floor(R.next() * 20) : 10 + Math.floor(R.next() * 40)}`);
    w(`  say e${i} capacity ${50 + Math.floor(R.next() * 100)}`);
    if (R.next() < 0.1) w(`  say e${i} has backup`);
  }
  // family 1: one ground rule per class (what an LLM writes for "class X has limit L")
  for (let c = 0; c < CL; c++) w(`@lim-c${c} rule\n  when ?x is-a c${c}\n  then ?x limit ${40 + 5 * Math.floor(R.next() * 8)}`);
  // family 2: one ground rule per zone
  const SH = ['day', 'night', 'rotating'];
  for (let z = 0; z < Z; z++) w(`@shift-z${z} rule\n  when ?x in-zone z${z}\n  then ?x shift ${SH[Math.floor(R.next() * 3)]}`);
  w(`@r-loc rule
  when ?x in-zone ?z
  then ?x located-in ?z
@r-loc-trans rule
  when ?a located-in ?b
  when ?b located-in ?c
  then ?a located-in ?c
@r-util rule
  when ?x load ?l
  when ?x capacity ?c
  let ?u = ?l * 100 / ?c
  then ?x util ?u
@r-over rule
  when ?x util ?u
  when ?x limit ?m
  test ?u > ?m
  then ?x overloaded yes
@r-alert rule
  when ?x overloaded yes
  unless ?x has backup
  then ?x alert yes
# written in a bad order on purpose: the first two conditions form a large cross product
@r-hotspot rule
  when ?y in-zone ?z
  when ?x in-zone ?z
  when ?x alert yes
  when ?y alert yes
  test ?x != ?y
  then ?x hotspot yes
@v-zone-alerts group
  match ?x alert yes
  match ?x in-zone ?z
  by ?z
  count ?x as ?n
@r-busy rule
  from $v-zone-alerts
  test ?n > 2
  then ?z busy yes
@r-busy-region rule
  when ?z busy yes
  when ?z located-in ?g
  when ?g is-a region
  then ?g has-busy-zone yes
@c-day-alert constraint
  when ?x alert yes
  when ?x shift day
  when ?x in-zone ?z
  when ?z busy yes
  message ?x raises an alert in busy zone ?z during the day shift`);
  return out.join('\n') + '\n';
}

export const QUERIES = {
  'loc-region': '@q group\n  match ?x located-in g0\n  count ?x as ?n\n@a answer\n  from $q\n',
  'point-limit': '@q find\n  match e17 limit ?l\n@a answer\n  from $q\n',
  'alerts': '@q group\n  match ?x alert yes\n  count ?x as ?n\n@a answer\n  from $q\n',
  'busy-regions': '@q group\n  match ?g has-busy-zone yes\n  count ?g as ?n\n@a answer\n  from $q\n',
  'violations': '@v check\n@q group\n  from $v\n  count ?x as ?n\n@a answer\n  from $q\n',
  'hotspots': '@q group\n  match ?x hotspot yes\n  count ?x as ?n\n@a answer\n  from $q\n',
  'whatif-add': '@w assume\n  add enew is-a c3\n  add enew in-zone z1\n  add enew load 99\n  add enew capacity 50\n@q group\n  in $w\n  match ?x alert yes\n  count ?x as ?n\n@a answer\n  from $q\n',
  'whatif-set': '@w assume\n  set e5 load 99\n  set e5 capacity 50\n@q group\n  in $w\n  match ?x alert yes\n  count ?x as ?n\n@a answer\n  from $q\n',
};

if (process.argv[1] && process.argv[1].endsWith('gen.mjs')) {
  const [N, CL, Z, dir, seed] = process.argv.slice(2);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/kb.sop`, generate(+N, +CL, +Z, +(seed || 1)));
  for (const [k, v] of Object.entries(QUERIES)) writeFileSync(`${dir}/${k}.sop`, v);
  console.log(`written ${dir}/kb.sop and ${Object.keys(QUERIES).length} queries`);
}
