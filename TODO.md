# TODO: resuming MRP-LLM work (state as of 2026-10-14 evening, updated on 2026-10-15)

The session stopped in the middle of the third pass (owner: "install the packages and build what is still missing"). **Nothing is
committed**: about 74 changed or new files in `mrp-llm/` and 4 in `Ploinky-Worker/` (`git status`). Read this file first, then
`eval/reports/history/mrp-strategies-2026-10-14.md` (measured results and defaults) and DS025/DS028.

## 0. Progress of 2026-10-15 (morning)

- Done: SaeRouted measured (sentence SAE: acme 33/40, acme-para 20/20; GPT-2 SAEs: 21/40, 12/20); unit tests
  (`tests/mrp/service-strategies.test.mjs`, 10 tests) and `npm run test:ml` (`tests-ml/`, 3 tests with the real models); inventory;
  DS025, DS028, README, api.html, the report addendum, dependencies.md; SWI-Prolog 9.0.4 (`tools/.solvers/swi-env`) and Soufflé 2.5
  built 32-bit (`tools/.solvers/souffle32`): the engine tests pass; a real bug of the Soufflé lowering fixed (division by zero on
  x86); **CNL-ACE** (acme 21/40, 0 wrong; acme-para 4/20), **schema-linker**, **FineTunedSOP** (pairs + LoRA training + ollama
  serving + strategy) implemented.
- **Note**: the openference plan expired (HTTP 402): the tiers `tiny`, `medium`, `good` do not answer; the live runs use `fast`.
- Running when this was written: the LoRA training (`state/finetune/train.log`, ~80 min) and the commonsense benchmarks.
- Left: serve the trained model (`tools/finetune/serve.sh`) and measure FineTunedSOP on acme and acme-para (tier `finetuned`);
  the defaults if the numbers ask for it; rebuild the test server (§3.4); the final report.

## 0b. Progress of 2026-10-15 (afternoon)

- FineTunedSOP served and measured (v1 acme 19/3, v2 acme 24/1, acme-para 5/0 and 10/0 with dense-slice); `tools/finetune/serve.sh`
  fixed (CPU only, `rope_theta`, the Qwen system message, a hashed model tag against Ploinky's response cache); `pairs.mjs` writes
  counts, chains and no-request pairs. Report addendum updated.
- Tiers `nano`, `micro`, `tiny` repointed to z.ai `glm-5.3-flash` (owner); backup `~/.pworker/config.json.bak-2026-10-15`.
- The owner's DGX Spark (`ssh pgx`) is shared: use it only when its GPU is idle. Left over there from an aborted attempt:
  `~/.ollama/models` (2.5 GB partial pull) and `~/mrp-ollama` (removal was blocked by the session permissions).
- Left: nothing blocking. Pre-existing failures of `npm test`: two timing tests under load and the held-out check (its archived guide
  folder `probably_obsolete/one-shot-formalization/...` is gone, so `scanned.guide` is 0).

## 1. State of the machine

- **Private Python environment**: `tools/.solvers/mrp-env/` (micromamba, Python 3.12.15; gitignored). It has clingo 5.8.2, SWI-Prolog
  10.0.0, torch 2.14.1+cpu, transformers 5.19, sentence-transformers 6.1, spaCy 3.8.16 + en_core_web_sm, nltk 3.10.3 (FrameNet 1.7,
  WordNet in `~/nltk_data`), sae-lens 6.54.5. Souffle 2.5 is extracted from the official Fedora 41 rpm into `tools/.solvers/souffle-rpm/`
  (sha512 verified). Symlinks: `tools/.solvers/{souffle/souffle, souffle/install/include, clingo/bin/clingo, swi/swipl}`. With these
  solvers the engine tests that "failed for environment reasons" now pass (router, differential, engine-code).
- **HuggingFace models** in `~/.cache/huggingface` (outside the repo, ~6.5 GB): naver/splade-cocondenser-ensembledistil,
  BAAI/bge-small-en-v1.5, gpt2 + jbloom/GPT2-Small-SAEs-Reformatted (release gpt2-small-res-jb).
- **APE** (Attempto Parsing Engine) built in `tools/.solvers/ape/ape.exe` (commit 5f4d5354; SWI-Prolog 10 prints a harmless
  `format_predicate` warning). `./ape.exe -text "Who works at Acme?" -solo drspp` works; words missing from its lexicon need prefixes
  (`n:projects`) or a user lexicon.
- **GPU**: AMD Cezanne iGPU (gfx90c), not supported by ROCm; everything runs on CPU (16 cores, 62 GB RAM). No sudo.
- **The strategy service** may still be running in the background (pid in the session scratchpad); `npm start` now starts it on its own
  (`mrp.strategyService.autostart`, `lib/mrp/strategy-service.mjs startStrategyService`).
- **Test server**: not running. The owner said it is a test server: rebuild it yourself (memory `test-server-free-to-rebuild`).

## 2. Done in the third pass (code exists, tested by hand; several items still lack unit tests, see §3)

| What | Where | Measured |
| --- | --- | --- |
| Strategy service v2: encode/splade, encode/dense, parse/spacy, sae/train, sae/encode, sae/gpt2, sae/gpt2-encode, frames/framenet, frames/units, frames/synonyms, discover/term-stats, discover/splade-stats | `services/strategy-service/server.py` | all operations answer |
| Python resolver + service autostart with `npm start` | `lib/mrp/strategy-service.mjs`, `tools/serve-local.mjs`, `server.config` in `server/http.mjs` | — |
| Retrieve slot = candidate predicates for the one-shot formalizer (the engine's slice stays exact): splade-slice, dense-slice, graph-walk, hybrid-rerank; memory slot splade-index, dense-index (indexes under `state/indexes/`) | `lib/mrp/retrieve.mjs`; wiring: `server/http.mjs` → `entry.agent.turnPolicy.retrieval` → `server/agent.mjs` authorExecution → `lib/formalize/strategies.mjs` oneShot → `one-shot/context.mjs extra` | acme-para (20 paraphrases), DirectSOP: no retrieval 15/20, splade 16, graph 16, hybrid 16, **dense 18**, 0 wrong |
| Roundtrip `embedding` (bge cosine, threshold 0.85) | `lib/mrp/pipeline.mjs` | catch 0.923, false alarms 0.038 (better than lexical 0.846) |
| Formalize `DependencyScaffold` (spaCy skeleton → phrase circuit; tiny model picks the predicate only when the phrase does not link; joins → unclear) | `lib/formalize/scaffold.mjs`, task `config/tasks/mrp-scaffold-label.md` | acme 19/40, **0 wrong**, ~0.2 calls/question |
| Formalize `SpladeRouted` / `SaeRouted` (triggers of `extractor` wires select schemas; SchemaGuidedLLM over them; nothing fires → unclear) | `lib/formalize/routed-extractors.mjs`; the lexicon now reads `extractor` wires (LEXICON_FORMAT 9) | **SpladeRouted: acme 33/40, acme-para 20/20**, 0 wrong. SaeRouted: not measured yet (§3.1) |
| Formalize `FrameGuided` (FrameNet frames of the message select predicates) | `lib/mrp/frames.mjs`, `lib/formalize/strategies.mjs` | acme 25/40, acme-para 10/20, 0 wrong |
| Discover `frame-seed` (FrameNet LUs ∩ WordNet synonyms → proposed lexemes) | `lib/mrp/frames.mjs`, route in `server/mrp-routes.mjs` | runs, but the proposals are noisy (same_as: rival, agree); review is mandatory |
| Discover `sae-sentence-embeddings`, `sae-llm-activations` (features named on tier good → proposed schema + extractor with a `feature:` trigger) | `lib/mrp/discover-sae.mjs`, task `config/tasks/mrp-discover-feature.md`, route | the setup ran: 637 passages, 20 features, 20 proposals written to the eval memory |
| `sae-pretrained-dictionary` | — | **stays not-implemented**: the 170 sae-lens releases are all over language models, none over a sentence-embedding model |
| SAE benchmark setup | `tools/eval/mrp/sae-setup.mjs` | written and run once (see 3.1) |
| New suite `eval/mrp-formalize-v1/acme-para.jsonl` + option `--retrieve` in `tools/eval/mrp/formalize.mjs` | | |

## 3. What remains, in order

### 3.1 Finish what is half done (start here)

1. **Measure SaeRouted.** The SAE extractors are already in the private eval memory (`state/mrp-eval/chat_data`, acme-demo; source
   `sae:acme_bench_202610141927`, weights in `state/sae/`). Run:
   `node tools/eval/mrp/formalize.mjs --suites acme,acme-para --strategies SaeRouted --tier fast`.
   Caution: many features were named with `is_a` (a generic predicate). Filter the generic predicates out of the naming prompt
   (`GENERIC` in `lib/mrp/frames.mjs`, reuse it in `discover-sae.mjs`), then rerun `sae-setup.mjs` (delete `state/mrp-eval` first, so
   the proposals of the old run disappear). Then also try `--strategy sae-llm-activations`.
2. **Unit tests** (with a fake `call`/client, never a real model) for: `skeletonOf`/`circuitOf` (`lib/formalize/scaffold.mjs`),
   `spladeSelect`/`saeSelect` and `routedExtractors` (unclear when nothing fires), `retrieveCandidates` (fake encode),
   `graphWalk`, `predicateDocuments`, `frameSeed` and `frameGuided` (fake call), `saeDiscover` (fake call + fake run), roundtrip
   `embedding` (fake serviceCall), the lexicon reading `extractor` wires and their serialization, `startStrategyService`/`servicePython`.
   Add a `test:ml` script for tests that load the real models (never in `npm test` or `test:fast`).
3. **Inventory**: register `tools/eval/mrp/sae-setup.mjs` and the new data in `eval/registry.json` (paths of `eval-mrp-formalize`),
   then `node tools/inventory/tests-and-evals.mjs`; otherwise `tests/project/tests-inventory.test.mjs` fails.
4. **Docs**: DS025 (catalog: DependencyScaffold, SpladeRouted, SaeRouted, FrameGuided, retrieve/memory, roundtrip embedding,
   frame-seed, the SAE strategies now implemented; "Retrieval for the formalizer"), DS028 (External strategies: the service's operation
   list, the private environment, the removal of `cross-engine`/SAE/frame-seed/splade from the not-implemented list), README (slot
   table), `docs/api.html` (discover frame-seed without passages, SAE discover), the report
   `eval/reports/history/mrp-strategies-2026-10-14.md` (an addendum with the numbers of §2). Then `node tools/check-spec-refs.mjs` and
   `node tools/docs/build-architecture.mjs`.
5. **`dependencies.md` + manifests**: record micromamba (sha256 8761c382…), the conda env (python 3.12.15, clingo 5.8.2, swi-prolog
   10.0.0, from conda-forge), souffle 2.5 (fedora-41 rpm, sha512 from the release's sha512sum.txt), the pip packages and versions of §1,
   APE (commit 5f4d5354, LGPL), and the models with their **licences**: SPLADE naver/splade-cocondenser-ensembledistil is
   **CC BY-NC-SA 4.0 (non-commercial)**, bge-small MIT, GPT-2 MIT, the GPT-2 SAEs (jbloom) MIT, FrameNet 1.7 its own licence, WordNet
   3.0 its licence. Write `tools/.solvers/*/manifest.json` as the ChatSOP convention asks.
6. **Full run**: `npm test` (expected: only the timing tests left, now that the solvers are installed; check), `npm test` in
   `../Ploinky-Worker` (144/144 at the last run).

### 3.2 Not implemented yet (feasible with what is installed)

7. **CNL-ACE** (formalize): a Ploinky task rewrites the English message in Attempto Controlled English; `tools/.solvers/ape/ape.exe`
   parses it (`-solo drspp` or `-solo drsxml`); map `query(X,who)`, `predicate(V,verb,S,O)`, `modifier_pp(V,prep,X)` to one
   phrase-mode `match` (`relation "verb prep"`), which the KnowledgeLinker binds (as DependencyScaffold does). Generate an APE user
   lexicon (`-ulexfile`) from the memory: lexeme verbs (`iv`/`tv` with the preposition) and entity labels as proper names (`pn_sg`),
   so the model does not have to prefix words. Service or Node? APE is a binary: Node can run it directly (`spawnSync`), with a timeout.
8. **schema-linker** (link slot): for phrase-mode circuits (DependencyScaffold, CNL-ACE), map the relation phrase to a predicate of the
   reviewed schemas when exactly one schema lexeme matches it, before the KnowledgeLinker. Apply it in the formalizers that write
   phrases, as a Model setting carried by `turnPolicy`.
9. **FineTunedSOP** (formalize, timeboxed): data = (question, circuit) pairs validated by the oracle, generated with the DS015
   generator (`tools/datasets/diversity/`) plus the correct circuits of the benchmarks; LoRA on a 0.5B model on CPU (peft is not
   installed yet: `tools/.solvers/mrp-env/bin/python -m pip install peft`); serve it through **ollama** (installed:
   `/usr/local/bin/ollama`) as a custom provider of Ploinky (`npx pworker provider ollama --endpoint http://127.0.0.1:11434/v1`) and a
   tier; the strategy = DirectSOP on that tier. Report the numbers honestly; do not promise the profile.
10. **frame-seed, better quality**: today it proposes noise. Ideas: keep only LUs whose frame is evoked by *at least two* forms of the
    predicate, or ask a tiny model to confirm "does X mean the same as the predicate's label?" (a Ploinky task), or keep it as is,
    since review is mandatory.

### 3.3 Benchmarks still to run (live, tier fast)

11. `--retrieve` on `commonsense` (a large vocabulary: 289 predicates) for DirectSOP; DependencyScaffold/SpladeRouted/FrameGuided on
    `commonsense` and `acme-ro`; the reflex and affect benchmarks are complete (report §Reflex, §Affect).
12. Then update **the defaults** if the numbers ask for it (e.g. retrieve `dense-slice` as the default for DirectSOP if it confirms on
    commonsense; formalize `SpladeRouted` for Models with a schema, it made 20/20 on paraphrases) and record them in the report and in DS025.

### 3.4 Final

13. **Rebuild the test server**: stop everything, delete `chat_data/` (test data, the owner agreed), `npm start` (it rebuilds the seeds,
    including the acme-demo schema and its extractor triggers, and starts the strategy service), check `/v1/mrp/strategies?check=1`
    (the service strategies `ready`), a turn on acme-demo with DirectSOP and one with SpladeRouted; leave it running.
14. **Final report** to the owner in Romanian, between `<<human-report>>` markers (skill human-report), without manual steps for the
    owner.

## 4. Things to know before you continue

- **Do not kill processes with `pgrep -f`/`pkill -f` on a pattern that appears in your own command**: twice the shell killed itself
  (exit 144). Use the pid file (`echo $! > …svc.pid`) or `ps -eo pid,comm,args | awk '$2 ~ /^python/ && /strategy-service/'`.
- The Ploinky purpose allowlist: every model call needs `answer-*`, `job:*`, `formalize` or `test:*` (memory `ploinky-purpose-allowlist`).
- The Ploinky cache returns identical prompts at once: the latencies of strategies that repeat prompts (Ensemble*, SchemaOrDirect)
  are not real; use `cache: 'off'` in the tags for a cold measurement.
- The MRP server tests use a stub parser that only knows `LocalLLMStepByStep`: a test model that does not test formalization must
  set `formalize: 'LocalLLMStepByStep'` (the Model default is now DirectSOP).
- Owner decisions of today: DirectSOP is the formalize default, faq-hybrid the reflex default, lexicon the affect default; "build as
  many strategies as possible"; install the packages; the test server is free to rebuild.
