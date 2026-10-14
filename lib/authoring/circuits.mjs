/**
 * Knowledge authoring helpers shared by the authoring paths (DS022 "The authoring path", "Ingesting documents into a base memory"):
 * the attached files are checked (text only, safe names, bounded), the vocabulary already in the theory is offered to the model, and
 * what the model wrote is validated with the knowledge validator together with the circuits it joins. The model itself is called
 * directly (lib/ingest/direct-author.mjs); the omp authoring loop that first used these helpers is archived in probably_obsolete/omp/.
 */
import path from 'node:path';
import {parse, validateProgram, wireText} from '../../sop/knowledge/index.mjs';
import {validateCircuits} from '../chat-data/memories.mjs';

export const LIMITS = Object.freeze({maxFiles: 10, maxFileBytes: 2_000_000, maxTotalBytes: 6_000_000, maxInstructionChars: 20_000});

const fail = (message, code = 'invalid_request', status = 400) => Object.assign(new Error(message), {code, status});

/** Validates attached files `[{name, text}]` and returns them with safe names; text only, no paths, bounded size. */
export function checkFiles(files = []) {
  if (!Array.isArray(files)) throw fail('files must be an array of {name, text}', 'invalid_files');
  if (files.length > LIMITS.maxFiles) throw fail(`At most ${LIMITS.maxFiles} files`, 'too_many_files', 413);
  let total = 0;
  const seen = new Set();
  return files.map(file => {
    if (!file || typeof file.name !== 'string' || typeof file.text !== 'string') throw fail('Each file needs a name and a text (UTF-8 text only)', 'invalid_files');
    const name = path.basename(file.name).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'file.txt';
    if (file.text.includes('\0')) throw fail(`File ${name} is not text; attach UTF-8 text files (txt, md, sop, csv, json, html)`, 'unsupported_file');
    const bytes = Buffer.byteLength(file.text);
    total += bytes;
    if (bytes > LIMITS.maxFileBytes || total > LIMITS.maxTotalBytes) throw fail('The attached files exceed the size limit', 'request_limit', 413);
    let unique = name;
    for (let i = 2; seen.has(unique); i++) unique = `${i}-${name}`;
    seen.add(unique);
    return {name: unique, text: file.text, bytes};
  });
}

/** The `predicate` wires of the circuits already in the theory: the vocabulary the new circuits must reuse. */
export function vocabularyOf(circuits) {
  return circuits.flatMap(c => parse(c.text).wires.filter(w => w.type === 'predicate').map(wireText)).join('\n\n');
}

/**
 * Validates what the agent wrote. `existing` are the circuits already in the theory ([{name, text}]). Returns
 * {ok, problems, warnings}; every problem is {code, message, file?, line?, wire?}.
 */
export function validateAuthored({knowledge, queries = '', existing = []}) {
  if (typeof knowledge !== 'string' || !knowledge.trim()) return {ok: false, problems: [{code: 'missing_output', file: 'knowledge.sop', message: 'knowledge.sop is missing or empty'}], warnings: []};
  const check = validateCircuits([{name: 'knowledge.sop', text: knowledge}], existing);
  const problems = [...check.problems];
  const warnings = [...check.warnings];
  if (queries.trim()) {
    const files = [...existing.map(c => ({name: c.name, text: c.text, role: 'knowledge'})), {name: 'knowledge.sop', text: knowledge, role: 'knowledge'}, {name: 'queries.sop', text: queries, role: 'query'}];
    for (const p of validateProgram(files, {authoring: true}).problems.filter(p => p.file === 'queries.sop')) (p.severity === 'warning' ? warnings : problems).push(p);
  }
  return {ok: problems.length === 0, problems, warnings};
}
