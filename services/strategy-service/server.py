#!/usr/bin/env python3
"""The MRP strategy service (DS028 "External strategies"): the parts of strategies that need Python, behind a small local HTTP API.

  GET  /selfcheck   {"ok": true, "service": "mrp-strategy-service", "version": 2, "strategies": {"<op>": {"available": bool, "missing": [...], "reason": str}}}
  POST /run         {"slot": "<group>", "strategy": "<name>", "input": {...}, "params": {...}}  ->  {"ok": true, "output": {...}, "trace": {...}}
                    or {"ok": false, "error": "..."}

The service computes; it stores nothing the MRP server needs later except what the caller names (an SAE's weights at `input.path`). It
listens on 127.0.0.1 only (MRP_STRATEGY_SERVICE_PORT, default 18090) and never calls a language model: a strategy that needs one asks the
MRP server, which goes through Ploinky Workers. Every model is loaded once per process, behind a lock, the first time an operation needs
it. An operation whose packages are missing reports them in /selfcheck and refuses /run.

Operations ("<slot>/<strategy>" keys):
  discover/term-stats       corpus term specificity from plain frequencies (no package): lexeme and predicate candidates
  discover/splade-stats     the same from SPLADE activations (MRP_SPLADE_MODEL, default naver/splade-cocondenser-ensembledistil)
  encode/splade             {texts, top} -> {vectors: [{term: weight}]}: the SPLADE terms of each text
  encode/dense              {texts} -> {vectors: [[float]]}: normalized sentence embeddings (MRP_DENSE_MODEL, default BAAI/bge-small-en-v1.5)
  parse/spacy               {text} -> {tokens: [{i, text, lemma, pos, tag, dep, head, ent}], sents}: an English dependency parse (en_core_web_sm)
  sae/train                 {passages, latents, epochs, l1, path} -> {features: [{id, passages: [index], mean}]}: a sparse autoencoder
                            trained on the dense embeddings of the passages, weights saved at `path`
  sae/encode                {path, texts, top} -> {features: [[{id, value}]]}: the active features of each text under a saved SAE
  sae/gpt2                  {passages, top, layer} -> {features: [{id, passages, corpus_rate}]}: features of the pre-trained GPT-2 small residual
                            SAEs (sae-lens release gpt2-small-res-jb) that fire on the passages
  sae/gpt2-encode           {texts, top, layer} -> {features: [[{id, value}]]}
  frames/framenet           {lemmas: ["work.v", ...]} -> {frames: {lemma: [{frame, elements: [{name, core}]}]}}: FrameNet 1.7 lexical units (nltk)
  frames/units              {frames: [name]} -> {units: {frame: ["employ.v", ...]}}: the lexical units of each frame
  frames/synonyms           {lemmas: [word]} -> {synonyms: {word: [words]}}: WordNet 3.0 verb synonyms of the first senses (nltk)
"""
import importlib.util
import json
import math
import os
import re
import sys
import threading
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = 2
STOP = set('a an the is are was were be been being am of in on at to from by with for about into over under than and or but if so as it its this that these those there here please not no do does did have has had will would can could should may might must i you he she we they them his her our your their my me us'.split())
GENERIC = Counter('time people year way day man thing woman life child world school state family student group country problem hand part place case week company system program question work government number night point home water room mother area money story fact month lot right study book eye job word business issue side kind head house service friend father power hour game line end member law car city community name president team minute idea kid body information back parent face others level office door health person art war history party result change morning reason research girl guy moment air teacher force education'.split())

_models = {}
_lock = threading.Lock()


def load(name, factory):
    """One model per process: the first caller loads it under the lock, the others wait and reuse it."""
    with _lock:
        if name not in _models:
            _models[name] = factory()
        return _models[name]


def missing(modules):
    return [m for m in modules if importlib.util.find_spec(m) is None]


def words(text):
    return [w for w in re.findall(r"[a-z][a-z']+", text.lower()) if w not in STOP and len(w) > 2]


def specificity(counts, total, top):
    scored = []
    for term, n in counts.items():
        if n < 2:
            continue
        scored.append((round(n / total * math.log(1 + n / (GENERIC.get(term, 0) + 0.5)), 6), term, n))
    scored.sort(reverse=True)
    return [{"term": t, "count": n, "score": s} for s, t, n in scored[:top]]


def verbs_of(terms):
    return [t["term"] for t in terms if re.search(r"(?:s|es|ed|ing|ate|ize|ify)$", t["term"])][:40]


# ---------------------------------------------------------------- SPLADE
def splade():
    def make():
        from transformers import AutoModelForMaskedLM, AutoTokenizer
        name = os.environ.get("MRP_SPLADE_MODEL", "naver/splade-cocondenser-ensembledistil")
        tok = AutoTokenizer.from_pretrained(name)
        return {"name": name, "tok": tok, "model": AutoModelForMaskedLM.from_pretrained(name).eval()}
    return load("splade", make)


def splade_vectors(texts, top=64):
    import torch
    s = splade()
    out = []
    with torch.no_grad():
        for text in texts:
            enc = s["tok"](text, return_tensors="pt", truncation=True, max_length=256)
            act = torch.log1p(torch.relu(s["model"](**enc).logits)).amax(dim=1).squeeze(0)
            vals, ids = torch.topk(act, k=min(top, act.shape[0]))
            vec = {}
            for v, i in zip(vals.tolist(), ids.tolist()):
                if v <= 0:
                    break
                term = s["tok"].convert_ids_to_tokens(i)
                if term.startswith("[") or term in STOP:
                    continue
                vec[term] = round(v, 4)
            out.append(vec)
    return out


def term_stats(inp, params):
    passages = inp.get("passages") or []
    counts = Counter(w for p in passages for w in words(p))
    terms = specificity(counts, sum(counts.values()) or 1, int(params.get("top", 60)))
    return {"lexemes": terms, "predicates": [{"name": v, "arity": None} for v in verbs_of(terms)]}, {"passages": len(passages), "tokens": sum(counts.values())}


def splade_stats(inp, params):
    passages = inp.get("passages") or []
    weights = Counter()
    for vec in splade_vectors(passages, 128):
        for term, w in vec.items():
            if term.isalpha() and len(term) > 2:
                weights[term] += w
    terms = specificity(Counter({t: max(2, round(w)) for t, w in weights.items()}), sum(weights.values()) or 1, int(params.get("top", 60)))
    return {"lexemes": terms, "predicates": [{"name": v, "arity": None} for v in verbs_of(terms)]}, {"passages": len(passages), "model": splade()["name"]}


def encode_splade(inp, params):
    return {"vectors": splade_vectors(inp.get("texts") or [], int(inp.get("top") or params.get("top", 64)))}, {"model": splade()["name"]}


# ---------------------------------------------------------------- dense
def dense():
    def make():
        from sentence_transformers import SentenceTransformer
        name = os.environ.get("MRP_DENSE_MODEL", "BAAI/bge-small-en-v1.5")
        return {"name": name, "model": SentenceTransformer(name, device="cpu")}
    return load("dense", make)


def dense_vectors(texts):
    d = dense()
    return d["model"].encode(list(texts), normalize_embeddings=True, batch_size=32, show_progress_bar=False)


def encode_dense(inp, params):
    vecs = dense_vectors(inp.get("texts") or [])
    return {"vectors": [[round(float(x), 5) for x in v] for v in vecs]}, {"model": dense()["name"], "dims": int(vecs.shape[1]) if len(vecs) else 0}


# ---------------------------------------------------------------- spaCy
def nlp():
    def make():
        import spacy
        return spacy.load(os.environ.get("MRP_SPACY_MODEL", "en_core_web_sm"))
    return load("spacy", make)


def parse_spacy(inp, params):
    doc = nlp()(inp.get("text") or "")
    tokens = [{"i": t.i, "text": t.text, "lemma": t.lemma_, "pos": t.pos_, "tag": t.tag_, "dep": t.dep_, "head": t.head.i, "ent": t.ent_type_ or None} for t in doc]
    return {"tokens": tokens, "sents": [[s.start, s.end] for s in doc.sents], "ents": [{"text": e.text, "label": e.label_, "start": e.start, "end": e.end} for e in doc.ents]}, {"model": nlp().meta.get("name")}


# ---------------------------------------------------------------- SAE on sentence embeddings
def sae_train(inp, params):
    import torch
    passages = inp.get("passages") or []
    if len(passages) < 4:
        raise ValueError("sae/train needs at least 4 passages")
    x = torch.tensor(dense_vectors(passages), dtype=torch.float32)
    latents, epochs, l1 = int(params.get("latents", 512)), int(params.get("epochs", 300)), float(params.get("l1", 0.002))
    torch.manual_seed(int(params.get("seed", 1)))
    enc, dec = torch.nn.Linear(x.shape[1], latents), torch.nn.Linear(latents, x.shape[1], bias=False)
    opt = torch.optim.Adam(list(enc.parameters()) + list(dec.parameters()), lr=float(params.get("lr", 0.003)))
    for _ in range(epochs):
        z = torch.relu(enc(x))
        loss = ((dec(z) - x) ** 2).mean() + l1 * z.abs().mean()
        opt.zero_grad()
        loss.backward()
        opt.step()
        with torch.no_grad():
            dec.weight.data /= dec.weight.data.norm(dim=0, keepdim=True).clamp_min(1e-6)
    with torch.no_grad():
        z = torch.relu(enc(x))
    path = inp.get("path")
    if path:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        torch.save({"enc": enc.state_dict(), "dec": dec.state_dict(), "latents": latents, "dense": dense()["name"]}, path)
    features = []
    for j in range(latents):
        col = z[:, j]
        active = (col > 0).nonzero().flatten().tolist()
        if not active or len(active) > 0.6 * len(passages):
            continue
        order = sorted(active, key=lambda i: -float(col[i]))[:8]
        features.append({"id": j, "passages": order, "count": len(active), "mean": round(float(col[active].mean()), 4)})
    features.sort(key=lambda f: (-f["count"], -f["mean"]))
    return {"features": features[: int(params.get("top", 40))]}, {"loss": round(float(loss), 6), "latents": latents, "passages": len(passages), "dense": dense()["name"]}


def sae_encode(inp, params):
    import torch
    saved = torch.load(inp["path"], weights_only=True)
    enc = torch.nn.Linear(len(saved["enc"]["weight"][0]), saved["latents"])
    enc.load_state_dict(saved["enc"])
    with torch.no_grad():
        z = torch.relu(enc(torch.tensor(dense_vectors(inp.get("texts") or []), dtype=torch.float32)))
    top = int(inp.get("top") or params.get("top", 8))
    out = []
    for row in z:
        vals, ids = torch.topk(row, k=min(top, row.shape[0]))
        out.append([{"id": int(i), "value": round(float(v), 4)} for v, i in zip(vals.tolist(), ids.tolist()) if v > 0])
    return {"features": out}, {"latents": saved["latents"]}


# ---------------------------------------------------------------- pre-trained SAEs of GPT-2 small
def gpt2(layer):
    def make():
        from sae_lens import SAE
        from transformer_lens import HookedTransformer
        sae = SAE.from_pretrained(release="gpt2-small-res-jb", sae_id=f"blocks.{layer}.hook_resid_pre")
        sae = sae[0] if isinstance(sae, tuple) else sae
        return {"model": HookedTransformer.from_pretrained("gpt2-small", device="cpu"), "sae": sae.eval(), "hook": f"blocks.{layer}.hook_resid_pre"}
    return load(f"gpt2-{layer}", make)


def gpt2_features(texts, layer):
    import torch
    g = gpt2(layer)
    out = []
    with torch.no_grad():
        for text in texts:
            _, cache = g["model"].run_with_cache(text[:2000], names_filter=g["hook"])
            acts = g["sae"].encode(cache[g["hook"]][0, 1:])  # skip the BOS position
            out.append(acts.amax(dim=0))
    return out


def sae_gpt2(inp, params):
    import torch
    passages = inp.get("passages") or []
    layer = int(params.get("layer", 6))
    acts = torch.stack(gpt2_features(passages, layer))
    fired = (acts > 0).float().mean(dim=0)
    candidates = ((fired > 0) & (fired <= float(params.get("maxRate", 0.5)))).nonzero().flatten().tolist()
    candidates.sort(key=lambda j: (-float(fired[j]), -float(acts[:, j].mean())))
    features = []
    for j in candidates[: int(params.get("top", 40))]:
        col = acts[:, j]
        order = sorted((col > 0).nonzero().flatten().tolist(), key=lambda i: -float(col[i]))[:8]
        features.append({"id": int(j), "passages": order, "corpus_rate": round(float(fired[j]), 4)})
    return {"features": features}, {"release": "gpt2-small-res-jb", "layer": layer, "latents": int(acts.shape[1])}


def sae_gpt2_encode(inp, params):
    import torch
    layer = int(params.get("layer", 6))
    top = int(inp.get("top") or params.get("top", 8))
    out = []
    for row in gpt2_features(inp.get("texts") or [], layer):
        vals, ids = torch.topk(row, k=min(top, row.shape[0]))
        out.append([{"id": int(i), "value": round(float(v), 4)} for v, i in zip(vals.tolist(), ids.tolist()) if v > 0])
    return {"features": out}, {"layer": layer}


# ---------------------------------------------------------------- FrameNet
def framenet():
    def make():
        from nltk.corpus import framenet as fn
        fn.frames("Being_employed")  # forces the corpus to load once
        return fn
    return load("framenet", make)


def frames_units(inp, params):
    """{frames: [name]} -> {units: {frame: [lexical unit names such as employ.v]}}: the lexical units of each frame."""
    fn = framenet()
    out = {}
    for name in inp.get("frames") or []:
        try:
            out[name] = sorted(fn.frame(name).lexUnit.keys())
        except Exception:
            out[name] = []
    return {"units": out}, {"framenet": "1.7"}


def frames_synonyms(inp, params):
    """{lemmas: ["employ", ...]} -> {synonyms: {lemma: [words]}}: the lemmas of the first `senses` WordNet verb senses of each word."""
    from nltk.corpus import wordnet as wn
    senses = int(params.get("senses", 2))
    out = {}
    for lemma in inp.get("lemmas") or []:
        words = []
        for syn in wn.synsets(lemma.replace(" ", "_"), pos=wn.VERB)[:senses]:
            words.extend(l.name().replace("_", " ") for l in syn.lemmas())
        out[lemma] = sorted(set(words) - {lemma})
    return {"synonyms": out}, {"wordnet": "3.0"}


def frames_framenet(inp, params):
    fn = framenet()
    out = {}
    for lemma in inp.get("lemmas") or []:
        found = []
        for lu in fn.lus(r"(?i)^" + re.escape(lemma) + r"$"):
            frame = lu.frame
            found.append({"frame": frame.name, "lu": lu.name, "elements": [{"name": name, "core": fe.coreType == "Core"} for name, fe in frame.FE.items()]})
        out[lemma] = found[: int(params.get("top", 5))]
    return {"frames": out}, {"framenet": "1.7"}


OPS = {
    "discover/term-stats": {"modules": [], "run": term_stats},
    "discover/splade-stats": {"modules": ["transformers", "torch"], "run": splade_stats},
    "encode/splade": {"modules": ["transformers", "torch"], "run": encode_splade},
    "encode/dense": {"modules": ["sentence_transformers", "torch"], "run": encode_dense},
    "parse/spacy": {"modules": ["spacy", "en_core_web_sm"], "run": parse_spacy},
    "sae/train": {"modules": ["sentence_transformers", "torch"], "run": sae_train},
    "sae/encode": {"modules": ["sentence_transformers", "torch"], "run": sae_encode},
    "sae/gpt2": {"modules": ["sae_lens", "transformer_lens", "torch"], "run": sae_gpt2},
    "sae/gpt2-encode": {"modules": ["sae_lens", "transformer_lens", "torch"], "run": sae_gpt2_encode},
    "frames/framenet": {"modules": ["nltk"], "run": frames_framenet},
    "frames/units": {"modules": ["nltk"], "run": frames_units},
    "frames/synonyms": {"modules": ["nltk"], "run": frames_synonyms},
}


def selfcheck():
    out = {}
    for key, s in OPS.items():
        miss = missing(s["modules"])
        out[key] = {"available": not miss, "missing": miss, **({"reason": "needs Python packages " + ", ".join(miss)} if miss else {})}
    return {"ok": True, "service": "mrp-strategy-service", "version": VERSION, "python": sys.version.split()[0], "strategies": out}


class Handler(BaseHTTPRequestHandler):
    def send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/selfcheck":
            return self.send(200, selfcheck())
        self.send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/run":
            return self.send(404, {"ok": False, "error": "not found"})
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get("content-length", 0)), 50_000_000)) or b"{}")
            key = f"{body.get('slot')}/{body.get('strategy')}"
            s = OPS.get(key)
            if not s:
                return self.send(404, {"ok": False, "error": f"no operation {key}"})
            miss = missing(s["modules"])
            if miss:
                return self.send(503, {"ok": False, "error": "needs Python packages " + ", ".join(miss)})
            output, trace = s["run"](body.get("input") or {}, body.get("params") or {})
            self.send(200, {"ok": True, "output": output, "trace": trace})
        except Exception as e:  # a failure is an answer, never a crash of the service
            self.send(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    port = int(os.environ.get("MRP_STRATEGY_SERVICE_PORT", "18090"))
    print(f"mrp-strategy-service on http://127.0.0.1:{port}", file=sys.stderr)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
