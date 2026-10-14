/** Checks of label-entities: every span is an exact passage of the chunk; {"none": true} alone means no mention. */
export function check(item, output) {
  const recs = (output.records ?? []).filter(r => !r.none);
  const problems = recs.filter(r => typeof r.span === 'string' && !item.text.includes(r.span)).map(r => `the span ${JSON.stringify(r.span.slice(0, 80))} is not in the text`);
  return problems.length ? {ok: false, problems, hint: 'Copy every span character for character from the text.'} : {ok: true, value: recs.length};
}
