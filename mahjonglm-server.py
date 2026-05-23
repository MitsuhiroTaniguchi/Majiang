#!/usr/bin/env python3
"""MahjongLM inference server — loads mitsutani/mahjonglm-10m and serves
next-token predictions over HTTP for the Node.js mahjong player."""

import os
import sys

# Disable parallel tokenizer processing to eliminate background thread spin-locks
os.environ["TOKENIZERS_PARALLELISM"] = "false"
# Limit math/neural network backend threads to 1 to prevent idle CPU spinning
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["VECLIB_MAXIMUM_THREADS"] = "1"
os.environ["NUMEXPR_NUM_THREADS"] = "1"

import gc
import json
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from transformers import PreTrainedTokenizerFast

# Try importing MLX and MLX-LM
USE_MLX = False
try:
    import mlx.core as mx
    import mlx_lm.utils
    from mlx_lm.models.cache import KVCache
    from huggingface_hub import snapshot_download
    from pathlib import Path
    USE_MLX = True
    
    # Configure strict memory limits to keep footprint minimal
    mx.set_cache_limit(64 * 1024 * 1024)       # 64MB cache limit
    mx.set_memory_limit(256 * 1024 * 1024)     # 256MB hard memory ceiling
except ImportError:
    print("MLX is not installed or not supported. Falling back to PyTorch.")

MODEL_ID = os.environ.get("MAHJONGLM_MODEL", "mitsutani/mahjonglm-10m")
TOKENIZER_ID = os.environ.get("MAHJONGLM_TOKENIZER", "")
try:
    PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8889
    if not (1 <= PORT <= 65535):
        raise ValueError
except (ValueError, IndexError):
    print(f"Usage: {sys.argv[0]} [port] (1-65535, default 8889)")
    sys.exit(1)

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
    import torch
    from transformers import AutoConfig, AutoModelForCausalLM
    config = AutoConfig.from_pretrained(model_path)
    rope_parameters = getattr(config, "rope_parameters", None) or {}
    if "rope_theta" in rope_parameters:
        config.rope_theta = rope_parameters["rope_theta"]
    model = AutoModelForCausalLM.from_pretrained(model_path, config=config, torch_dtype=torch.float32)
    return model, config

def load_model_mlx(model_path_or_id):
    try:
        if os.path.isdir(model_path_or_id):
            model_dir = Path(model_path_or_id)
        else:
            model_dir = Path(snapshot_download(repo_id=model_path_or_id))
            
        config_path = model_dir / "config.json"
        if not config_path.exists():
            return None, None
            
        with open(config_path, "r") as f:
            config = json.load(f)
            
        rope_parameters = config.get("rope_parameters", {})
        if "rope_theta" in rope_parameters:
            config["rope_theta"] = rope_parameters["rope_theta"]
            
        model, config = mlx_lm.utils.load_model(model_dir, model_config=config)
        return model, config
    except Exception as e:
        print(f"  [mlx] Failed to load MLX model: {e}")
        return None, None

model = None
config = None
backend = "pytorch"
device = "cpu"

if USE_MLX:
    print(f"Trying to load model via MLX from {MODEL_ID} ...")
    model, config = load_model_mlx(MODEL_ID)
    if model is not None:
        backend = "mlx"

if model is None:
    import torch
    print(f"Loading model via PyTorch from {MODEL_ID} ...")
    try:
        model, config = load_model(MODEL_ID)
    except Exception as e:
        print(f"  Failed to load from HuggingFace: {e.__class__.__name__}")
        local_model = os.path.join(SCRIPT_DIR, "model")
        if os.path.isdir(local_model):
            print(f"  Trying local PyTorch: {local_model}")
            model, config = load_model(local_model)
        else:
            print("ERROR: Could not load model via PyTorch. Set MAHJONGLM_MODEL=/path/to/model or log in with `huggingface-cli login`")
            sys.exit(1)
            
    model.eval()
    if torch.backends.mps.is_available():
        device = "mps"
    elif torch.cuda.is_available():
        device = "cuda"
    else:
        device = "cpu"
    model = model.to(device)
    print(f"PyTorch model loaded on {device} (vocab={tokenizer.vocab_size})")
else:
    print(f"MLX model loaded successfully (vocab={tokenizer.vocab_size})")

vocab = tokenizer.get_vocab()
id_to_token = {v: k for k, v in vocab.items()}
VOCAB_SIZE = len(vocab)

_request_count = 0
_inference_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):

    def do_GET(self):
        if self.path == "/health":
            dev_name = "mlx" if backend == "mlx" else device
            self._json({"status": "ok", "device": dev_name, "vocab_size": VOCAB_SIZE})
            return
        if self.path == "/vocab":
            self._json({"vocab": vocab})
            return
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path == "/generate":
            body = self._read_json()
            if body is None:
                self._json({"error": "invalid request body"}, 400)
                return
            tokens = body.get("tokens")
            if not isinstance(tokens, list) or len(tokens) == 0 or len(tokens) > 4096:
                self._json({"error": "tokens must be a non-empty list (max 4096)"}, 400)
                return
            n = body.get("n", 1)
            if not isinstance(n, int) or n < 1 or n > 50:
                self._json({"error": "n must be 1-50"}, 400)
                return
            temperature = body.get("temperature", 0.8)
            if not isinstance(temperature, (int, float)) or temperature < 0:
                temperature = 0.8
            allowed = body.get("allowed")

            ids = []
            for t in tokens:
                tid = vocab.get(t)
                if tid is None:
                    self._json({"error": f"unknown token: {t}"}, 400)
                    return
                ids.append(tid)

            with _inference_lock:
                if backend == "mlx":
                    input_ids = mx.array([ids], dtype=mx.int32)
                    caches = [KVCache() for _ in range(len(model.layers))]
                    generated = []

                    for step in range(n):
                        out = model(input_ids, cache=caches)
                        logits = out[0, -1, :]

                        if allowed:
                            mask = mx.full((VOCAB_SIZE,), float("-inf"))
                            for tok in allowed:
                                tid = vocab.get(tok)
                                if tid is not None:
                                    mask[tid] = 0.0
                            logits = logits + mask

                        if temperature > 0:
                            logits = logits / temperature
                            probs = mx.softmax(logits, axis=-1)
                            token_id = int(mx.random.categorical(logits).item())
                        else:
                            probs = mx.softmax(logits, axis=-1)
                            token_id = int(mx.argmax(logits).item())
                        token_str = id_to_token.get(token_id, "<unk>")

                        generated.append({"token": token_str, "prob": round(float(probs[token_id].item()), 4)})
                        input_ids = mx.array([[token_id]], dtype=mx.int32)

                    self._json({"generated": generated})

                    # Reclaim intermediate MLX buffers and memory
                    mx.metal.clear_cache()
                    global _request_count
                    _request_count += 1
                    if _request_count % 100 == 0:
                        gc.collect()
                    return
                else:
                    import torch
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

                            if temperature > 0:
                                logits = logits / temperature
                                probs = torch.softmax(logits, dim=-1)
                                token_id = int(torch.multinomial(probs, 1).item())
                            else:
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
        if length > 1_048_576:
            return None
        try:
            return json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, ValueError):
            return None

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
    from http.server import ThreadingHTTPServer
    print(f"Listening on http://127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
