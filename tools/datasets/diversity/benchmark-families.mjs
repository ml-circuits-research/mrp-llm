import {GIVEN_NAMES} from './names.mjs';

// Construction gold is computed here, without asking an engine to invent the expected answer.
// The oracle separately checks these expectations before a case can be persisted.
const predicate = (id, types, closed = false, {roles = ['subject', 'object', 'topic'], label = id.replaceAll('_', ' '), description = ''} = {}) =>
  `@${id} predicate\n  args ${types.map((t, i) => `${roles[i]}:${t}`).join(' ')}\n  label en ${JSON.stringify(label)}\n  description ${JSON.stringify(description || `${label}: ${roles.slice(0, types.length).join(', ')}.${closed ? ' The retained list is exhaustive.' : ' The list is not declared exhaustive.'}`)}\n${closed ? '  closed true\n' : ''}`;
const fact = (id, atom, extra = '') => `@f${id} fact\n  holds ${atom}\n${extra}`;
const query = lines => `@q query\n${lines.map(s => `  ${s}`).join('\n')}\n`;
const names = (split, n) => {
  const pool = GIVEN_NAMES.filter(x => split === 'dev' ? ['romanian', 'hungarian', 'spanish', 'french'].includes(x.culture) : ['nigerian', 'kenyan', 'indian', 'japanese'].includes(x.culture));
  const seed = split === 'dev' ? 20261001 : 20261002;
  return `${pool[(n + seed) % pool.length].name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z]+/g, '_')}_${split}_${n}`;
};
const expected = (feature, requires, value) => ({feature, requires, complete: true, ...value});
// Only question-mentioned constants enter the author's entity vocabulary. In particular
// no gold answer is leaked by declaring every value in a generated fact.
function namedEntities(question, q, knowledge) {
  const defined = new Set([...knowledge.matchAll(/^@(\S+) (?:predicate|rule|default|integrity|aggregate|fact)$/gm)].map(m => m[1]));
  const ids = new Set([...`${question}\n${q}`.matchAll(/\b[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)+\b/gu)].map(m => m[0]).filter(id => !defined.has(id)));
  return [...ids].sort().map(id => `@${id} entity\n  kind entity\n  label en ${JSON.stringify(id.replaceAll('_', ' '))}\n  alias en ${JSON.stringify(id)}\n`).join('');
}
const assemble = (family, variant, question, knowledge, q, gold, facts, depth = 1) => ({family, variant, question, knowledge: namedEntities(question, q, knowledge) + knowledge, query: q, expected: gold, facts, depth});

export function benchmarkCase(family, index, {split = 'dev', scale = 1000} = {}) {
  if (!['dev', 'preview'].includes(split)) throw new Error('Generator can write dev only; sealed requires a separate sealing procedure');
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('index must be nonnegative');
  const a = names(split, index * 3), b = names(split, index * 3 + 1), c = names(split, index * 3 + 2);
  const shift = index % 10;
  switch (family) {
    case 'f2': {
      // Count distinct employees even when each has two project assignments; grouped sum/max are separate variants.
      const variant = index % 6, n = 18 + shift * 2;
      const company = `firm_${a}`;
      const rows = Array.from({length: n}, (_, j) => ({person: names(split, index * 100 + j + 500), amount: 50 + ((j % 11) * 17 + index * 7) % 110}));
      const parts = [
        predicate('assigned_to', ['entity', 'entity'], true, {description: 'A person (subject) is assigned to a firm or project (object). Every assignment is listed.'}),
        predicate('compensation', ['entity', 'integer'], true, {description: 'Compensation paid to a person (subject), with a numerical amount (object). Every person compensation is listed.'})
      ];
      let seq = 0;
      for (const r of rows) { parts.push(fact(++seq, `assigned_to ${r.person} ${company}`)); parts.push(fact(++seq, `assigned_to ${r.person} project_${r.person}`)); parts.push(fact(++seq, `compensation ${r.person} ${r.amount}`)); }
      if (variant === 0) return assemble(family, 'count-distinct', `How many distinct people are assigned to ${company}?`, parts.join(''), query(['mode count', `where assigned_to ?p ${company}`, 'select ?p']), expected('Distinct count with duplicate assignments', ['facts', 'count'], {status: 'supported', count: n}), seq);
      if (variant === 4) {
        const best = Math.max(...rows.map(r => r.amount));
        const winners = rows.filter(r => r.amount === best).map(r => ({p: r.person}));
        return assemble(family, 'rank-highest', `Which people assigned to ${company} receive the highest compensation?`, parts.join(''), query(['where all', `  assigned_to ?p ${company}`, '  compensation ?p ?v', 'end', 'rank highest ?v', 'select ?p']), expected('Rank numerical rows and preserve ties', ['facts', 'select'], {status: 'supported', rows: winners}), seq);
      }
      if (variant === 5) {
        const department = `department_${a}`, other = `department_${b}`;
        parts.push(predicate('department_pay', ['entity', 'entity', 'integer'], true, {label: 'person department pay', description: 'Pay of a person (subject) in a department (object) with numerical amount (topic). All department pay entries are listed.'}),
          predicate('department_total', ['entity', 'integer'], false, {label: 'total pay by department', description: 'Total pay (object) grouped by department (subject), summed across department_pay entries; not grouped by firm.'}));
        rows.forEach((r, j) => parts.push(fact(++seq, `department_pay ${r.person} ${j % 2 ? other : department} ${r.amount}`)));
        parts.push('@by_department aggregate\n  over department_pay ?person ?dept ?amount\n  group ?dept\n  sum ?amount as ?total\n  yields department_total ?dept ?total\n');
        const total = rows.reduce((sum, r, j) => sum + (j % 2 ? 0 : r.amount), 0);
        return assemble(family, 'grouped-sum', `What is the total pay recorded for ${department}, not ${other}?`, parts.join(''), query([`where department_total ${department} ?total`, 'select ?total']), expected('Group-by sum selects the requested department', ['facts', 'aggregate'], {status: 'supported', rows: [{total}]}), seq);
      }
      const kind = ['', 'sum', 'max', 'count'][variant], target = `result_${kind}_${a}`;
      parts.push(predicate(target, ['entity', 'integer'], false, {label: `${kind} of compensation`, description: `The ${kind} of compensation (object) of people assigned to a firm (subject); aggregated across the firm's employees.`}));
      parts.push(`@aggregation aggregate\n  over assigned_to ?p ${company}\n  over compensation ?p ?v\n  ${kind} ${kind === 'count' ? '?p' : '?v'} as ?total\n  yields ${target} ${company} ?total\n`);
      const value = variant === 1 ? rows.reduce((s, r) => s + r.amount, 0) : variant === 2 ? Math.max(...rows.map(r => r.amount)) : n;
      return assemble(family, kind, kind === 'count' ? `How many distinct employees of ${company} receive compensation?` : `What is the ${kind} of compensation for the employees of ${company}?`, parts.join(''), query([`where ${target} ${company} ?total`, 'select ?total']), expected('Real aggregate over numerical facts', ['facts', 'aggregate'], {status: 'supported', rows: [{total: value}]}), seq);
    }
    case 'f3': {
      if (index % 4 === 3) {
        const knowledge = predicate('cleared', ['entity'], false, {description: 'A person (subject) is known cleared; the register is partial and absence does not establish that a person is not cleared.'}) + fact(1, `cleared ${a}`) + fact(2, `cleared ${b}`);
        const question = split === 'dev' ? `How many people are known to be cleared in the partial list containing ${a} and ${b}? Give a lower bound, not an exact total.` : `What minimum number of certified persons is evidenced by the unfinished register listing ${a} alongside ${b}? Do not assume a final tally.`;
        return assemble(family, 'open-count-lower-bound', question, knowledge, query(['mode count', 'where cleared ?p', 'select ?p']), expected('Open predicate gives only an at-least count', ['facts', 'count'], {status: 'supported', count: 2, bound: 'at_least'}), 2);
      }
      const closed = index % 2 === 0, seen = index % 4 === 0;
      const knowledge = predicate('cleared', ['entity'], closed, {description: closed ? 'A person (subject) belongs to the complete clearance register. The retained list is exhaustive: absence means not listed, not an explicit negative claim.' : 'A person (subject) is known cleared on a partial list. Lack of an entry cannot establish absence.'}) + (seen ? fact(1, `cleared ${a}`) : fact(1, `cleared ${b}`));
      const status = closed ? seen ? 'refuted' : 'supported' : seen ? 'supported' : 'unknown';
      const question = split === 'dev' ? (closed ? `Is ${a} absent from the complete list of cleared people?` : `Is ${a} on the partial list of cleared people?`) : (closed ? `Has ${a} been left off the exhaustive clearance roster?` : `Does the unfinished clearance register establish that ${a} has passed clearance?`);
      return assemble(family, closed ? 'closed-absence' : 'open-positive', question, knowledge, query([`where ${closed ? 'absent ' : ''}cleared ${a}`]), expected('Closed-world absence is not an open-world negative', ['facts', closed ? 'closed_world' : 'open_world', ...(closed ? ['naf'] : [])], {status}), 1);
    }
    case 'f4': {
      const cut = index % 2 === 0, length = 10 + shift * 2, start = `station_${a}`, target = `station_${a}_${length}`;
      const nodes = Array.from({length: length + 1}, (_, j) => j ? `${start}_${j}` : start), links = [];
      for (let j = 0; j < length; j++) if (!cut || j !== Math.floor(length / 2)) links.push([nodes[j], nodes[j + 1]]);
      for (let j = 0; j < length * 3; j++) links.push([`distraction_${b}_${j}`, `distraction_${b}_${j + 1}`]);
      const blocked = index % 3 === 0;
      if (cut) links.push([nodes[Math.floor(length / 2) - 1], `detour_${c}_0`], [`detour_${c}_0`, nodes[Math.floor(length / 2) + 1]]);
      const k = predicate('link', ['entity', 'entity'], false, {description: 'A directed link from one station (subject) to the next station (object); the link list is not declared exhaustive.'}) +
        predicate('blocked', ['entity'], true, {description: 'Station (subject) is blocked; the retained list of blocked stations is exhaustive.'}) +
        predicate('reached', ['entity', 'entity'], false, {description: 'Destination station (object) is reachable from starting station (subject) by directed links without entering a blocked station; the relation is derived, and missing paths are not closed-world negatives.'}) +
        links.map(([x, y], j) => fact(j + 1, `link ${x} ${y}`)).join('') +
        (cut && blocked ? fact(links.length + 1, `blocked detour_${c}_0`) : '') +
        '@base rule\n  when link ?origin ?next\n  when absent blocked ?origin\n  when absent blocked ?next\n  then reached ?origin ?next\n@step rule\n  when reached ?origin ?via\n  when link ?via ?next\n  when absent blocked ?next\n  then reached ?origin ?next\n';
      const reachable = !cut || !blocked;
      return assemble(family, cut ? blocked ? 'blocked-detour' : 'open-detour' : 'intact', `Can one reach ${target} from ${start} without entering a blocked station?`, k, query([`where reached ${start} ${target}`]), expected('Transitive reachability with a cut, blocked detour, and 3N distractors', ['facts', 'rules', 'recursion', 'naf', 'closed_world'], {status: reachable ? 'supported' : 'unknown'}), links.length + Number(cut && blocked), length);
    }
    case 'f5': {
      // Two independent arithmetic requirements identify one assignment, or prove inconsistency.
      const bound = 3 + shift, total = index % 5 === 4 ? bound * 2 : bound + (index % 3);
      const possible = Array.from({length: bound + 1}, (_, x) => ({x, y: total - x})).find(({x, y}) => y >= 0 && y <= bound && x < y);
      const weighted = possible ? 2 * possible.x + possible.y : 3 * bound;
      const q = `@assignment constraint\n  var ?x int 0 ${bound}\n  var ?y int 0 ${bound}\n  require ?x plus ?y equal ${total}\n  require 2 times ?x plus ?y equal ${weighted}\n  require ?x below ?y\n  task possible\n  select ?x ?y\n`;
      const question = split === 'dev' ? `Let x be ${a}'s assignment and y be ${b}'s assignment. Both are integers from 0 to ${bound} inclusive. Is there an assignment where x plus y equals ${total}, twice x plus y equals ${weighted}, and x is less than y? Give x and y if possible.` : `Assign integer x to ${a} and integer y to ${b}, each in the closed range 0 through ${bound}. Can their sum be ${total}, their weighted sum (2 times x plus y) be ${weighted}, and x strictly precede y? Supply the pair if feasible.`;
      return assemble(family, 'bounded-assignment', question, predicate('participant', ['entity']) + fact(1, `participant ${a}`) + fact(2, `participant ${b}`), q, expected('Unique finite assignment with two equations and an inequality', ['constraint'], {status: possible ? 'possible' : 'inconsistent', ...(possible ? {witness: possible} : {})}), 2);
    }
    case 'f6': {
      const start = '2026-03-01', end = '2026-06-01', variant = index % 6;
      const gap = variant === 0 || variant === 3, expires = variant === 1;
      const k = predicate('certified', ['entity'], false, {description: 'A person (subject) holds a time-bounded certification.'}) +
        predicate('on_shift', ['entity'], false, {description: 'A person (subject) is on shift during the validity interval of the fact.'}) +
        predicate('may_work', ['entity'], false, {label: 'permission to work', description: 'A person (subject) may work only at times when both certified and on shift; this permission is derived from the overlap of their validity intervals.'}) +
        fact(1, `certified ${a}`, `  valid 2026-01-01 ${expires ? '2026-05-15' : '2026-12-31'}\n`) +
        fact(2, `on_shift ${a}`, '  valid 2026-02-01 2026-04-01\n') +
        fact(3, `on_shift ${a}`, `  valid ${gap ? '2026-04-02' : '2026-04-01'} 2026-07-01\n`) +
        '@derived rule\n  when certified ?x\n  when on_shift ?x\n  then may_work ?x\n';
      const point = variant === 3 || variant === 5, overlap = variant === 4;
      const date = variant === 3 ? '2026-04-01' : '2026-06-01';
      const temporal = point ? `at ${date}` : overlap ? 'overlaps 2026-04-01 2026-05-01' : `during ${start} ${end}`;
      const question = point ? `May ${a} work on ${date}?` : overlap ? `Does ${a} have permission to work at some time overlapping April 1 to May 1, 2026?` : `May ${a} work throughout ${start} to ${end}?`;
      return assemble(family, point ? 'point-boundary' : overlap ? 'interval-overlap' : gap ? 'gap' : expires ? 'expiry' : 'continuous', question, k, query([`where may_work ${a}`, temporal]), expected('Derived intervals: point, overlap and throughout respect gaps and exclusive ends', ['facts', 'rules', 'temporal', 'interval', 'snapshot_derived', ...(!point && !overlap ? ['throughout'] : [])], {status: point ? gap ? 'unknown' : 'supported' : overlap ? 'supported' : gap || expires ? 'unknown' : 'supported'}), 3);
    }
    case 'f7': {
      const depth = 1 + shift, exception = index % 2 === 1, parts = [
        predicate('seed', ['entity'], false, {description: 'Starting premise (subject) for the chain of rule deductions.'}),
        predicate('eligible', ['entity'], false, {description: 'Person (subject) is eligible under an ordinary default after the last stage; a stronger exception default instead supports explicitly not eligible.'}),
        predicate('exception', ['entity'], false, {description: 'Person (subject) has an exception that activates the higher-priority negative eligibility default.'})
      ];
      for (let j = 1; j <= depth; j++) parts.push(predicate(`stage_${j}`, ['entity'], false, {description: `Person (subject) reaches deduction stage ${j} through ${j} rule applications from the seed.`}));
      parts.push(fact(1, `seed ${a}`));
      for (let j = 1; j <= depth; j++) parts.push(`@r_${j} rule\n  when ${j === 1 ? 'seed' : `stage_${j - 1}`} ?x\n  then stage_${j} ?x\n`);
      if (exception) parts.push(fact(2, `exception ${a}`));
      parts.push(`@usual default\n  when stage_${depth} ?x\n  then eligible ?x\n  priority 1\n@override default\n  when exception ?x\n  then not eligible ?x\n  priority 2\n`);
      const question = split === 'dev' ? `After ${depth} rule steps, is ${a} eligible, accounting for priority of exceptions?` : `For ${a}, trace ${depth} deductions from the starting premise. Does the ordinary eligibility policy hold, or does a stronger exceptional policy defeat it?`;
      return assemble(family, exception ? 'exception' : 'default', question, parts.join(''), query([`where eligible ${a}`]), expected('Rule depth 1–10 with a priority exception', ['facts', 'rules', 'default'], {status: exception ? 'refuted' : 'supported'}), Number(exception) + 1, depth);
    }
    case 'f8': {
      if (![1000, 10000].includes(scale)) throw new Error('F8 scale must be 1000 or 10000 facts');
      const conflict = index % 2 === 0;
      if (conflict) {
        const unrelated = Array.from({length: scale - 2}, (_, j) => fact(j + 3, `approved other_${split}_${index}_${j}`)).join('');
        return assemble(family, 'both', `Among ${scale} claims, is ${a} approved, disproved, or both?`, predicate('approved', ['entity'], false, {description: 'Person (subject) has an approval claim; explicit not approved is a distinct contrary claim, and both claims may coexist.'}) + fact(1, `approved ${a}`) + fact(2, `not approved ${a}`) + unrelated, query([`where approved ${a}`]), expected('Both positive and negative evidence survive amid unrelated claims', ['facts', 'classical_negation'], {status: 'both'}), scale);
      }
      const unrelated = Array.from({length: scale - 2}, (_, j) => fact(j + 3, `booking other_${split}_${index}_${j} slot_${j} occupant_${j}`)).join('');
      const k = predicate('booking', ['entity', 'entity', 'entity'], false, {description: 'A booking has a room (subject), slot (object), and occupant (topic); two different occupants in one room and slot violate unique_booking.'}) +
        predicate('violation', ['entity', 'entity'], false, {label: 'integrity violation', description: 'An integrity violation identifies the violated constraint (subject) and its witness room (object); an integrity rule produces this relation, not an assertion about the room.'}) +
        fact(1, `booking ${a} ${b} ${c}`) + fact(2, `booking ${a} ${b} ${a}`) + unrelated +
        '@unique_booking integrity\n  never all\n    booking ?r ?s ?p\n    booking ?r ?s ?other\n    compare ?p not_equal ?other\n  end\n  witness ?r\n  message "Two occupants of one room and slot"\n  severity error\n';
      const question = split === 'dev' ? `Among ${scale} bookings, which integrity constraint is violated for room ${a}?` : `Within ${scale} reservations, what consistency condition is broken at ${a}?`;
      return assemble(family, 'integrity', question, k, query([`where violation ?c ${a}`, 'select ?c']), expected('Integrity violation is reported as data amid distinct bookings', ['facts', 'integrity', 'compare_in_rules'], {status: 'supported', rows: [{c: 'unique_booking'}]}), scale);
    }
    case 'f9': {
      if (![1000, 10000, 100000, 1000000].includes(scale)) throw new Error(`Unsupported scale ${scale}; use 1e3, 1e4, 1e5, or 1e6`);
      const n = scale, compact = n > 1000;
      const relation = compact ? 'l' : 'linked';
      const entity = (which, j) => compact ? `${which}${index}_${j}` : `${which === 'd' ? a : b}_${j}`;
      const k = predicate(relation, ['entity', 'entity'], true, {label: 'directed link', description: 'A directed link has a source node (subject) and destination node (object); the retained link list is exhaustive, allowing absence claims for a specified source and destination.'}) + Array.from({length: n}, (_, j) => fact(j + 1, `${relation} ${entity('d', j)} ${entity('h', j)}`)).join('');
      const j = index % n, variant = index % 3;
      if (variant === 1) {
        const question = split === 'dev' ? `Among ${n} links including ${entity('d', j)} linked to ${entity('h', j)}, how many distinct source nodes occur?` : `In the dataset of ${n} recorded edges, one example goes from ${entity('d', j)} to ${entity('h', j)}. What is the number of distinct originating vertices?`;
        return assemble(family, `count-1e${Math.log10(n)}`, question, k, query(['mode count', `where ${relation} ?source ?destination`, 'select ?source']), expected(`Count distinct source nodes across ${n} physical facts`, ['facts', 'count'], {status: 'supported', count: n}), n);
      }
      if (variant === 2) {
        const missing = `missing_${split}_${index}`;
        const question = split === 'dev' ? `Is ${missing} absent from the complete list of sources linked to ${entity('h', j)} among ${n} links?` : `Given an exhaustive edge roster with ${n} records, is ${missing} missing as an origin for destination ${entity('h', j)}?`;
        return assemble(family, `closed-absence-1e${Math.log10(n)}`, question, k, query([`where absent ${relation} ${missing} ${entity('h', j)}`]), expected(`Closed-world absence across ${n} physical facts`, ['facts', 'naf', 'closed_world'], {status: 'supported'}), n);
      }
      const question = split === 'dev' ? `Does ${entity('d', j)} link to ${entity('h', j)} among ${n} different links?` : `Within ${n} recorded edges, is there a connection from ${entity('d', j)} into ${entity('h', j)}?`;
      return assemble(family, `membership-1e${Math.log10(n)}`, question, k, query([`where ${relation} ${entity('d', j)} ${entity('h', j)}`]), expected(`True membership in a materialized ${n}-fact relation`, ['facts'], {status: 'supported'}), n);
    }
    default: throw new Error(`Unknown family ${family}`);
  }
}
export const BENCHMARK_FAMILIES = ['f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9'];
