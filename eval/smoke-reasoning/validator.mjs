/**
 * Validator of the knowledge wire grammar, as the smoke harness uses it. The grammar, the parser, the validator and the
 * governance now live in `sop/knowledge/` (the single source, DS004); this file re-exports them under the names the harness
 * and the adapters import and keeps the command line:
 *
 *   node eval/smoke-reasoning/validator.mjs [--authoring] <file.sop>...   validate files (--authoring: the mode of a wire author,
 *                                                                          host-written governance fields are ignored with a warning)
 *   node eval/smoke-reasoning/validator.mjs --grammar                      the grammar table as Markdown
 *   node eval/smoke-reasoning/validator.mjs --grammar-compact [types]      the compact grammar of the authoring skill
 */
import {fileURLToPath} from 'node:url';
import {main} from '../../sop/knowledge/cli.mjs';

export * from '../../sop/knowledge/index.mjs';

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
