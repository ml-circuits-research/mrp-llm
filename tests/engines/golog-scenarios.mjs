/** Mode-of-work scenarios shared by the golog-swi tests (and compared with the htn-strips-planner): [name, knowledge, query]. */
const PRED = names => names.map(n => `@${n} predicate\n  args subject:entity\n`).join('');
const ACT = (id, req, add, cost = 1, rem = null) => `@${id} action\n  params ?x\n  requires ${req} ?x\n  adds ${add} ?x\n${rem ? `  removes ${rem} ?x\n` : ''}  cost ${cost}\n`;

export const SCENARIOS = [
  ['loop-until-reaches-goal', PRED(['item', 'warm', 'done']) + '@f1 fact\n  holds item a\n' + ACT('heat', 'item', 'warm', 1) + ACT('finish', 'warm', 'done', 1) +
    '@m method\n  achieves done ?x\n  when item ?x\n  binding strict\n  step until warm ?x max 3\n    ~heat ?x\n  end\n  step ~finish ?x\n', '@q query\n  mode plan\n  where done a\n'],
  ['loop-until-cap-is-budget', PRED(['item', 'warm', 'done', 'cold']) + '@f1 fact\n  holds item a\n' + ACT('heat', 'item', 'cold', 1) + ACT('finish', 'item', 'done', 1) +
    '@m method\n  achieves done ?x\n  when item ?x\n  binding strict\n  step until warm ?x max 2\n    ~heat ?x\n  end\n  step ~finish ?x\n', '@q query\n  mode plan\n  where done a\n'],
  ['pick-a-target-under-a-norm', '@link predicate\n  args source:entity destination:entity\n@blocked predicate\n  args subject:entity\n  closed true\n@visited predicate\n  args subject:entity\n' +
    '@f1 fact\n  holds link h t1\n@f2 fact\n  holds link h t2\n@f3 fact\n  holds blocked t1\n@visit action\n  params ?h ?t\n  requires link ?h ?t\n  adds visited ?t\n  cost 1\n' +
    '@no_t1 norm\n  forbid ~visit ?h ?t\n  when blocked ?t\n  severity hard\n  binding strict\n' +
    '@m method\n  achieves visited ?t\n  binding strict\n  step pick ?h where link ?h ?t\n  step ~visit ?h ?t\n', '@q query\n  mode plan\n  where visited t2\n'],
  ['any-order-forced-by-preconditions', PRED(['job', 'cut', 'sanded', 'finished']) + '@f1 fact\n  holds job a\n' + ACT('cut_it', 'job', 'cut', 2) + ACT('sand_it', 'cut', 'sanded', 3) + ACT('finish_it', 'sanded', 'finished', 1) +
    '@m method\n  achieves finished ?x\n  when job ?x\n  binding strict\n  step any_order\n    ~sand_it ?x\n    ~cut_it ?x\n  end\n  step ~finish_it ?x\n', '@q query\n  mode plan\n  where finished a\n'],
  ['optional-step-skipped-when-costly', PRED(['job', 'prepped', 'done', 'checked']) + '@f1 fact\n  holds job a\n' + ACT('prep', 'job', 'prepped', 1) + ACT('check', 'prepped', 'checked', 5) + ACT('do_it', 'prepped', 'done', 1) +
    '@m method\n  achieves done ?x\n  when job ?x\n  binding strict\n  step ~prep ?x\n  step optional ~check ?x\n  step ~do_it ?x\n', '@q query\n  mode plan\n  where done a\n'],
  ['subtask-uses-its-own-method', PRED(['job', 'a_done', 'b_done', 'all_done']) + '@f1 fact\n  holds job a\n' + ACT('do_a', 'job', 'a_done', 2) + ACT('do_b', 'a_done', 'b_done', 3) + ACT('seal', 'b_done', 'all_done', 1) +
    '@m_a method\n  achieves a_done ?x\n  when job ?x\n  binding strict\n  step ~do_a ?x\n@m_all method\n  achieves all_done ?x\n  when job ?x\n  binding strict\n  step a_done ?x\n  step ~do_b ?x\n  step ~seal ?x\n', '@q query\n  mode plan\n  where all_done a\n'],
  ['forbid-before-qualifier-picks-the-other-order', PRED(['job', 'x_ready', 'y_ready', 'both']) + '@f1 fact\n  holds job a\n' + ACT('make_x', 'job', 'x_ready', 1) + ACT('make_y', 'job', 'y_ready', 1) + ACT('join', 'job', 'both', 1) +
    '@y_after_x norm\n  forbid ~make_y ?x\n  before ~make_x\n  severity hard\n  binding strict\n' +
    '@m method\n  achieves both ?x\n  when job ?x\n  binding strict\n  step any_order\n    ~make_y ?x\n    ~make_x ?x\n  end\n  step ~join ?x\n', '@q query\n  mode plan\n  where both a\n'],
  ['at-most-once-forbids-the-repeat', PRED(['job', 'done']) + '@f1 fact\n  holds job a\n' + ACT('poke', 'job', 'poked', 1) + ACT('wrap', 'job', 'done', 1) +
    '@once norm\n  forbid ~poke ?x\n  at_most_once\n  severity hard\n  binding strict\n' +
    '@m method\n  achieves done ?x\n  when job ?x\n  binding strict\n  step ~poke ?x\n  step ~poke ?x\n  step ~wrap ?x\n', '@q query\n  mode plan\n  where done a\n'],
  ['oblige-within-soft-is-paid-when-skipped', PRED(['job', 'done', 'logged']) + '@f1 fact\n  holds job a\n' + ACT('work', 'job', 'done', 2) + ACT('log_it', 'job', 'logged', 1) +
    '@promptly norm\n  oblige ~log_it ?x\n  when job ?x\n  within 2\n  severity soft\n  cost 10\n' +
    '@m method\n  achieves done ?x\n  when job ?x\n  binding strict\n  step optional ~log_it ?x\n  step ~work ?x\n', '@q query\n  mode plan\n  where done a\n'],
  ['oblige-before-hard-forces-the-step', PRED(['job', 'done', 'warned']) + '@f1 fact\n  holds job a\n' + ACT('work', 'job', 'done', 1) + ACT('warn', 'job', 'warned', 1) +
    '@warn_first norm\n  oblige ~warn ?x\n  when job ?x\n  before ~work\n  severity hard\n  binding strict\n' +
    '@m method\n  achieves done ?x\n  when job ?x\n  binding strict\n  step choose\n    ~work ?x\n    ~warn ?x\n  end\n', '@q query\n  mode plan\n  where done a\n'],
  ['conform-method-deviation-by-order', PRED(['job', 'cut', 'sanded']) + '@f1 fact\n  holds job a\n' + ACT('cut_it', 'job', 'cut', 1) + ACT('sand_it', 'job', 'sanded', 1) +
    '@m method\n  achieves sanded ?x\n  when job ?x\n  binding strict\n  step ~cut_it ?x\n  step ~sand_it ?x\n', '@t trace\n  step ~sand_it a\n  step ~cut_it a\n@q query\n  mode conform\n  trace $t\n'],
  ['conform-method-ok-with-optional-and-if', PRED(['job', 'big', 'cut', 'sanded']) + '@f1 fact\n  holds job a\n' + ACT('cut_it', 'job', 'cut', 1) + ACT('sand_it', 'job', 'sanded', 1) + ACT('measure', 'job', 'measured', 1) +
    '@m method\n  achieves sanded ?x\n  when job ?x\n  binding strict\n  step optional ~measure ?x\n  step ~cut_it ?x\n  step ~sand_it ?x\n', '@t trace\n  step ~measure a\n  step ~cut_it a\n  step ~sand_it a\n@q query\n  mode conform\n  trace $t\n'],
  ['conform-advisory-method-deviation-only-listed', PRED(['job', 'cut', 'sanded']) + '@f1 fact\n  holds job a\n' + ACT('cut_it', 'job', 'cut', 1) + ACT('sand_it', 'job', 'sanded', 1) +
    '@m method\n  achieves sanded ?x\n  when job ?x\n  binding advisory\n  step ~cut_it ?x\n  step ~sand_it ?x\n', '@t trace\n  step ~sand_it a\n@q query\n  mode conform\n  trace $t\n'],
  ['conform-forbid-always-with-permit', '@prod predicate\n  args subject:entity\n@window predicate\n  args subject:entity\n@halted predicate\n  args subject:entity\n@f1 fact\n  holds prod s1\n@f2 fact\n  holds window s1\n' + ACT('halt', 'prod', 'halted', 1) +
    '@no_halt norm\n  forbid ~halt ?x\n  when prod ?x\n  severity hard\n@ok_in_window norm\n  permit ~halt ?x\n  when window ?x\n  overrides $no_halt\n', '@t trace\n  step ~halt s1\n@q query\n  mode conform\n  trace $t\n'],
  ['why-not-via-blocked-by-two-norms', PRED(['job', 'done', 'x_ready']) + '@f1 fact\n  holds job a\n' + ACT('hasty', 'job', 'done', 1) + ACT('careful', 'x_ready', 'done', 2) + ACT('prep', 'job', 'x_ready', 1) +
    '@n1 norm\n  forbid ~hasty ?x\n  severity hard\n  binding strict\n@m method\n  achieves done ?x\n  when job ?x\n  binding strict\n  step choose\n    ~hasty ?x\n    ~careful ?x\n  end\n', '@q query\n  mode why_not\n  where done a\n  via ~hasty a\n'],
  ['procedure-renders-the-method', PRED(['job', 'done']) + '@f1 fact\n  holds job a\n' + ACT('work', 'job', 'done', 1) +
    '@m method\n  achieves done ?x\n  when job ?x\n  version 3\n  binding strict\n  step ~work ?x\n', '@q query\n  mode procedure\n  where done a\n']
];
