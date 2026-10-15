#!/usr/bin/env bash
# Serves the FineTunedSOP model (tools/finetune/train.py output) through ollama and makes it a Ploinky tier (DS028 "Routed formalizers").
# Additive: it adds the provider `ollama` (http://127.0.0.1:11434/v1, no key) and the tier `finetuned` to the user's Ploinky
# configuration; existing providers and tiers are not changed. Usage: tools/finetune/serve.sh [model dir] [ollama model name]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODEL_DIR="$(realpath "${1:-$ROOT/state/finetune/model}")"
NAME="${2:-mrp-finetuned-sop}"
PWORKER="node $ROOT/node_modules/pworker/bin/pworker.mjs"
if ! curl -sf http://127.0.0.1:11434/api/version >/dev/null; then
  # CPU only: the ROCm runner of ollama crashes on integrated AMD GPUs it does not support (gfx90c); a 0.5B model is fast enough on CPU.
  ROCR_VISIBLE_DEVICES=-1 HIP_VISIBLE_DEVICES=-1 CUDA_VISIBLE_DEVICES= OLLAMA_LLM_LIBRARY=cpu nohup ollama serve > "$ROOT/state/finetune/ollama.log" 2>&1 &
  for _ in $(seq 1 40); do curl -sf http://127.0.0.1:11434/api/version >/dev/null && break; sleep 0.5; done
fi
# transformers 5 writes rope_theta under rope_parameters; the ollama converter reads only the top-level key (without it rope base is 0
# and the logits are NaN), so it is copied up.
node -e "const fs=require('fs'),f=process.argv[1],c=JSON.parse(fs.readFileSync(f));if(c.rope_theta==null&&c.rope_parameters?.rope_theta!=null){c.rope_theta=c.rope_parameters.rope_theta;fs.writeFileSync(f,JSON.stringify(c,null,2))}" "$MODEL_DIR/config.json"
# The training prompts went through the Qwen chat template, which adds its default system message when there is none; the
# Modelfile gives the same one (without it the model answers in prose).
cat > "$MODEL_DIR/Modelfile" <<MODELFILE
FROM $MODEL_DIR
TEMPLATE """{{- range .Messages }}<|im_start|>{{ .Role }}
{{ .Content }}<|im_end|>
{{ end }}<|im_start|>assistant
"""
SYSTEM """You are Qwen, created by Alibaba Cloud. You are a helpful assistant."""
PARAMETER stop "<|im_end|>"
PARAMETER temperature 0
MODELFILE
# The tag is a hash of the weights and the Modelfile: Ploinky's response cache keys on the served model, so a retrained or
# reconfigured model gets new keys instead of the replies of the previous one. (The OpenAI catalog of ollama names a model with its tag.)
TAGGED="$NAME:$(cat "$MODEL_DIR"/*.safetensors "$MODEL_DIR/Modelfile" | sha256sum | cut -c1-12)"
ollama create "$TAGGED" -f "$MODEL_DIR/Modelfile"
$PWORKER provider ollama --endpoint http://127.0.0.1:11434/v1 --rpm 600 || true
$PWORKER tier finetuned --provider ollama --model "$TAGGED"
(cd "$ROOT" && node -e "import('pworker/admin').then(m => m.restartProxy({always: true})).then(() => console.log('Ploinky proxy restarted'))")
echo "served: ollama model $TAGGED as the Ploinky tier finetuned"
