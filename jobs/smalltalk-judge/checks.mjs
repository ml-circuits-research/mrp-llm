/** Checks of smalltalk-judge: one record per item with five integer scores from 1 to 5. */
const DIMS = ['relevance', 'tone', 'naturalness', 'honesty', 'brevity'];
export function check(item, output) {
  const r = (output.records ?? [])[0];
  const bad = DIMS.filter(d => !(Number.isInteger(r?.[d]) && r[d] >= 1 && r[d] <= 5));
  return bad.length ? {ok: false, problems: [`scores must be integers from 1 to 5: ${bad.join(', ')}`], hint: 'Give every scale an integer from 1 to 5.'} : {ok: true};
}
