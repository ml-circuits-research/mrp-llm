/**
 * Validation of a circuit by the product validators, for the capability battery: the knowledge validator (`validateProgram`,
 * sop/knowledge/) and the model-surface admission (`parse` of sop/parser.mjs, `checkModelProgram` of sop/declarative.mjs and
 * `validateGraph`). `validate` returns the problem codes (errors and warnings apart); `checkTags` turns the codes into the
 * `k.check.CODE` and `m.check.CODE` capability tags.
 */
import {validateProgram, GRAMMAR} from '../../sop/knowledge/index.mjs';
import {parse as parseModel, validateGraph} from '../../sop/parser.mjs';
import {checkModelProgram, MODEL_TYPES} from '../../sop/declarative.mjs';
import {splitCircuits, SESSION_TYPES} from '../../lib/query-author/session.mjs';
import {parse as parseKnowledge} from '../../sop/knowledge/lexical.mjs';
import {ENUMS} from '../../sop/enums.mjs';
import {messageActs} from '../../sop/message-acts.mjs';

/**
 * The closed values of a model field: sop/enums.mjs ENUMS, and for `pragmatic kind` the message acts the reply memory in use declares
 * (memory data since P-2.1, 2026-10-03; without chat data the shipped conversation-v1).
 */
export const enumValues = (type, field) => (type === 'pragmatic' && field === 'kind' ? messageActs().kinds : ENUMS[type]?.[field]);

/** The admission code of a model-surface error message (`compare_form: @q ...` -> compare_form), or `admission` without one. */
export const modelCode = message => /^([a-z]+(?:_[a-z]+)+):/.exec(String(message))?.[1] ?? 'admission';

/** Knowledge circuits: {errors, warnings} as code lists. `files` = [{name, text, role}]. */
export function validateKnowledge(files, opts = {}) {
  const {problems} = validateProgram(files, opts);
  return {errors: problems.filter(p => p.severity !== 'warning').map(p => p.code), warnings: problems.filter(p => p.severity === 'warning').map(p => p.code)};
}

/**
 * Model-surface circuit (what the formalizer writes): {ok, code, message}. Session definitions next to the model wires (`predicate`,
 * `rule`, `default`, `aggregate`) are split off as the product's admission does (lib/query-author/session.mjs); a `candidate` or an `if`
 * may name one of their rules (Q-LANG-10).
 */
export function validateModel(text) {
  try {
    const hasDefinitions = [...String(text).matchAll(/^@\S+\s+(\S+)\s*$/gm)].some(m => SESSION_TYPES.has(m[1]));
    const split = hasDefinitions ? splitCircuits(text) : null;
    const definitions = split ? new Map(parseKnowledge(split.definitions).wires.map(w => [w.id, w.type])) : new Map();
    const program = parseModel(split ? split.model : text);
    checkModelProgram({wires: program.wires.filter(w => MODEL_TYPES.has(w.type))}, {definitions});
    if (split) program.wires.push(...[...definitions.keys()].map(id => ({id, type: 'value', fields: {data: ['0']}, line: 0})));
    validateGraph(program);
    return {ok: true};
  } catch (e) {
    return {ok: false, code: modelCode(e.message), message: e.message};
  }
}

const looksModel = text => {
  const types = [...String(text).matchAll(/^@\S+\s+(\S+)\s*$/gm)].map(m => m[1]);
  return types.some(t => MODEL_TYPES.has(t) && t !== 'query' && t !== 'constraint') || /^\s+(where|scope)\s+match\s*$/m.test(text) || /^\s+match\s*$/m.test(text);
};

/** Validator-code tags of a collected circuit (see tools/capabilities/coverage.mjs for the circuit shapes). */
export function checkTags(circuit) {
  const tags = new Set();
  try {
    if (circuit.knowledge !== undefined || circuit.query !== undefined) {
      const files = [{name: 'knowledge', text: circuit.knowledge ?? '', role: 'knowledge'}];
      if (circuit.query) files.push({name: 'query', text: circuit.query, role: 'query'});
      const r = validateKnowledge(files);
      for (const c of [...r.errors, ...r.warnings]) tags.add('k.check.' + c);
      return tags;
    }
    const text = circuit.text ?? '';
    if (circuit.surface === 'model' || (circuit.surface === undefined && looksModel(text))) {
      const r = validateModel(text);
      if (!r.ok && r.code !== 'admission') tags.add('m.check.' + r.code);
      return tags;
    }
    // a host or model circuit with types the knowledge grammar does not have is not a knowledge circuit
    const types = [...text.matchAll(/^@\S+\s+(\S+)\s*$/gm)].map(m => m[1]);
    if (!circuit.role && types.some(t => !GRAMMAR[t])) return tags;
    const r = validateKnowledge([{name: 'circuit', text, role: circuit.role ?? 'any'}]);
    for (const c of [...r.errors, ...r.warnings]) tags.add('k.check.' + c);
  } catch { /* a validator crash is not a capability */ }
  return tags;
}
