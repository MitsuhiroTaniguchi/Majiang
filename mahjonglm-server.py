#!/usr/bin/env python3
"""MahjongLM inference server — loads mitsutani/mahjonglm-10m and serves
next-token predictions over HTTP for the Node.js mahjong player."""

import json
import sys
import os
import torch
from http.server import HTTPServer, BaseHTTPRequestHandler
from transformers import AutoConfig, AutoModelForCausalLM, PreTrainedTokenizerFast

MODEL_ID = os.environ.get("MAHJONGLM_MODEL", "mitsutani/mahjonglm-10m")
TOKENIZER_ID = os.environ.get("MAHJONGLM_TOKENIZER", "")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8889

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

TOKENIZER_SEARCH_PATHS = [
    TOKENIZER_ID,
    os.path.join(SCRIPT_DIR, "tokenizer"),
    "/tmp/MahjongLM/tokenizer",
    MODEL_ID,
    "mitsutani/mahjonglm-dataset",
]

tokenizer = None
for tok_path in TOKENIZER_SEARCH_PATHS:
    if not tok_path:
        continue
    try:
        print(f"Trying tokenizer: {tok_path} ...")
        tokenizer = PreTrainedTokenizerFast.from_pretrained(tok_path)
        print(f"  Loaded tokenizer from {tok_path}")
        break
    except Exception as e:
        print(f"  Failed: {e.__class__.__name__}")
        continue

if tokenizer is None:
    print("ERROR: Could not load tokenizer from any source.")
    print("Set MAHJONGLM_TOKENIZER=/path/to/tokenizer or log in with `huggingface-cli login`")
    sys.exit(1)

def load_model(model_path):
    config = AutoConfig.from_pretrained(model_path)
    rope_parameters = getattr(config, "rope_parameters", None) or {}
    if "rope_theta" in rope_parameters:
        config.rope_theta = rope_parameters["rope_theta"]
    model = AutoModelForCausalLM.from_pretrained(model_path, config=config, torch_dtype=torch.float32)
    return model, config

print(f"Loading model from {MODEL_ID} ...")
try:
    model, config = load_model(MODEL_ID)
except Exception as e:
    print(f"  Failed to load from HuggingFace: {e.__class__.__name__}")
    local_model = os.path.join(SCRIPT_DIR, "model")
    if os.path.isdir(local_model):
        print(f"  Trying local: {local_model}")
        model, config = load_model(local_model)
    else:
        print("ERROR: Could not load model. Set MAHJONGLM_MODEL=/path/to/model or log in with `huggingface-cli login`")
        sys.exit(1)
model.eval()

if torch.backends.mps.is_available():
    device = "mps"
elif torch.cuda.is_available():
    device = "cuda"
else:
    device = "cpu"
model = model.to(device)
print(f"Model loaded on {device}  (vocab={tokenizer.vocab_size})")

vocab = tokenizer.get_vocab()
id_to_token = {v: k for k, v in vocab.items()}
VOCAB_SIZE = len(vocab)


class Handler(BaseHTTPRequestHandler):

    def do_GET(self):
        if self.path == "/health":
            self._json({"status": "ok", "device": device, "vocab_size": VOCAB_SIZE})
            return
        if self.path == "/vocab":
            self._json({"vocab": vocab})
            return
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path == "/generate":
            body = self._read_json()
            tokens = body["tokens"]
            allowed = body.get("allowed")
            n = body.get("n", 1)
            temperature = body.get("temperature", 0.8)

            ids = []
            for t in tokens:
                tid = vocab.get(t)
                if tid is None:
                    self._json({"error": f"unknown token: {t}"}, 400)
                    return
                ids.append(tid)

            input_ids = torch.tensor([ids], dtype=torch.long, device=device)
            generated = []

            with torch.no_grad():
                past = None
                for step in range(n):
                    out = model(input_ids, past_key_values=past, use_cache=True)
                    logits = out.logits[0, -1, :].float()
                    past = out.past_key_values

                    if allowed:
                        mask = torch.full((VOCAB_SIZE,), float("-inf"), device=device)
                        for tok in allowed:
                            tid = vocab.get(tok)
                            if tid is not None:
                                mask[tid] = 0.0
                        logits = logits + mask

                    if temperature > 0 and temperature != 1.0:
                        logits = logits / temperature

                    probs = torch.softmax(logits, dim=-1)
                    token_id = int(torch.argmax(logits).item())
                    token_str = id_to_token.get(token_id, "<unk>")

                    generated.append({"token": token_str, "prob": round(float(probs[token_id]), 4)})
                    input_ids = torch.tensor([[token_id]], dtype=torch.long, device=device)

            self._json({"generated": generated})
            return

        self._json({"error": "not found"}, 404)

    # ---- helpers ----
    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length))

    def _json(self, data, code=200):
        payload = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        if "/health" not in (args[0] if args else ""):
            sys.stderr.write(f"  [mahjonglm] {fmt % args}\n")


if __name__ == "__main__":
    print(f"Listening on http://127.0.0.1:{PORT}")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
