#!/usr/bin/env python3
"""LoRA fine-tuning of the FineTunedSOP model (DS028 "Routed formalizers") on (prompt, circuit) pairs of tools/finetune/pairs.mjs, on CPU.

The pairs are trained in the chat format the model is served with (user = the compact prompt, assistant = the circuit); the loss covers
the assistant tokens only. The adapter is merged into the base model and saved with its tokenizer as safetensors, ready for
`ollama create` (tools/finetune/serve.sh) and a Ploinky tier.

  tools/.solvers/mrp-env/bin/python -I tools/finetune/train.py --pairs state/finetune/train.jsonl --out state/finetune/model \
      [--base Qwen/Qwen2.5-0.5B-Instruct] [--epochs 1] [--limit 0]
"""
import argparse, json, math, os, random, time
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import LoraConfig, get_peft_model

ap = argparse.ArgumentParser()
ap.add_argument("--pairs", required=True); ap.add_argument("--out", required=True)
ap.add_argument("--base", default="Qwen/Qwen2.5-0.5B-Instruct"); ap.add_argument("--epochs", type=float, default=1.0)
ap.add_argument("--lr", type=float, default=2e-4); ap.add_argument("--batch", type=int, default=8); ap.add_argument("--limit", type=int, default=0)
ap.add_argument("--max-len", type=int, default=640); ap.add_argument("--seed", type=int, default=1)
a = ap.parse_args()
torch.manual_seed(a.seed); random.seed(a.seed)
torch.set_num_threads(os.cpu_count() or 8)
rows = [json.loads(l) for l in open(a.pairs) if l.strip()]
random.shuffle(rows)
if a.limit: rows = rows[: a.limit]
tok = AutoTokenizer.from_pretrained(a.base)
model = AutoModelForCausalLM.from_pretrained(a.base, torch_dtype=torch.float32)
model = get_peft_model(model, LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, target_modules=["q_proj", "k_proj", "v_proj", "o_proj"], task_type="CAUSAL_LM"))

def encode(r):
    prompt = tok.apply_chat_template([{"role": "user", "content": r["prompt"]}], tokenize=False, add_generation_prompt=True)
    p = tok(prompt, add_special_tokens=False)["input_ids"]
    c = tok(r["completion"] + tok.eos_token, add_special_tokens=False)["input_ids"]
    ids = (p + c)[: a.max_len]
    return ids, ([-100] * len(p) + c)[: a.max_len]

data = [encode(r) for r in rows]
opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=a.lr)
steps = math.ceil(len(data) * a.epochs / a.batch)
sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / 20) * max(0.05, 1 - s / steps))
model.train()
t0, order = time.time(), []
for step in range(steps):
    if len(order) < a.batch: order += random.sample(range(len(data)), len(data))
    batch, order = [data[i] for i in order[: a.batch]], order[a.batch:]
    n = max(len(x) for x, _ in batch)
    ids = torch.tensor([x + [tok.pad_token_id] * (n - len(x)) for x, _ in batch])
    lab = torch.tensor([y + [-100] * (n - len(y)) for _, y in batch])
    att = torch.tensor([[1] * len(x) + [0] * (n - len(x)) for x, _ in batch])
    loss = model(input_ids=ids, attention_mask=att, labels=lab).loss
    loss.backward(); opt.step(); sched.step(); opt.zero_grad()
    if step % 10 == 0 or step == steps - 1:
        print(json.dumps({"step": step + 1, "of": steps, "loss": round(float(loss), 4), "s": round(time.time() - t0)}), flush=True)
merged = model.merge_and_unload()
os.makedirs(a.out, exist_ok=True)
merged.save_pretrained(a.out, safe_serialization=True)
tok.save_pretrained(a.out)
json.dump({"base": a.base, "pairs": len(rows), "epochs": a.epochs, "steps": steps, "lora": {"r": 16, "alpha": 32, "targets": ["q_proj", "k_proj", "v_proj", "o_proj"]}, "seconds": round(time.time() - t0)}, open(os.path.join(a.out, "training.json"), "w"), indent=1)
print(json.dumps({"saved": a.out, "seconds": round(time.time() - t0)}), flush=True)
