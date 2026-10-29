"""--local-models：按 LM Studio / Ollama 的目录结构扫出 GGUF，登记成可分析的 model id。"""
import json
from types import SimpleNamespace

import gguf
import numpy as np
import pytest
import torch
from flask import Flask

from backend.models import local_library
from backend.models.load_utils import gguf_load_args, gguf_metadata
from backend.models.model_loader import gemma_runtime_dtype

Q4_K_M = 15


def _write_gguf(path, arch="qwen3", file_type=Q4_K_M):
    path.parent.mkdir(parents=True, exist_ok=True)
    writer = gguf.GGUFWriter(str(path), arch)
    writer.add_file_type(file_type)
    writer.add_tensor("token_embd.weight", np.zeros((2, 2), dtype=np.float32))
    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()
    return path


@pytest.fixture
def lmstudio(tmp_path):
    root = tmp_path / "lmstudio"
    _write_gguf(root / "lmstudio-community" / "Qwen3-0.6B-GGUF" / "Qwen3-0.6B-Q4_K_M.gguf")
    _write_gguf(root / "lmstudio-community" / "Qwen3-0.6B-GGUF" / "mmproj-model-f16.gguf")
    _write_gguf(root / "someone" / "Odd-GGUF" / "odd.gguf", arch="notarealarch")
    mlx = root / "mlx-community" / "Qwen3-0.6B-4bit"
    mlx.mkdir(parents=True)
    (mlx / "config.json").write_text(json.dumps({"model_type": "qwen3", "quantization": {"bits": 4}}))
    (mlx / "model.safetensors").write_bytes(b"\0" * 8)
    return root


def _ollama_manifest(root, host, repo, tag, layers):
    path = root / "manifests" / host / repo / tag
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"schemaVersion": 2, "layers": layers}))


@pytest.fixture
def ollama(tmp_path):
    root = tmp_path / "ollama"
    _write_gguf(root / "blobs" / "sha256-aaa")
    _write_gguf(root / "blobs" / "sha256-bbb", arch="gemma3")
    model = "application/vnd.ollama.image.model"
    _ollama_manifest(root, "registry.ollama.ai", "library/qwen3", "0.6b",
                     [{"mediaType": model, "digest": "sha256:aaa", "size": 1}])
    _ollama_manifest(root, "registry.ollama.ai", "someone/tuned", "latest",
                     [{"mediaType": model, "digest": "sha256:bbb", "size": 1}])
    _ollama_manifest(root, "registry.ollama.ai", "library/mlxonly", "latest",
                     [{"mediaType": "application/vnd.ollama.image.tensor", "digest": "sha256:ccc", "size": 5}])
    return root


def _by_id(models):
    return {m.id: m for m in models}


def test_lmstudio_gguf_listed_mmproj_skipped_mlx_explained(lmstudio):
    models = _by_id(local_library.scan_lmstudio(lmstudio, frozenset({"qwen3"})))
    qwen = models["lmstudio/lmstudio-community/Qwen3-0.6B-GGUF/Qwen3-0.6B-Q4_K_M.gguf"]
    assert (qwen.supported, qwen.architecture, qwen.quantization) == (True, "qwen3", "Q4_K_M")
    assert not any("mmproj" in mid for mid in models)
    odd = models["lmstudio/someone/Odd-GGUF/odd.gguf"]
    assert not odd.supported and "notarealarch" in odd.reason
    mlx = models["lmstudio/mlx-community/Qwen3-0.6B-4bit"]
    assert (mlx.format, mlx.supported, mlx.reason) == ("mlx", False, local_library.MLX_REASON)


def test_ollama_manifests_map_to_blobs(ollama):
    models = _by_id(local_library.scan_ollama(ollama, frozenset({"qwen3", "gemma3"})))
    assert models["ollama/qwen3:0.6b"].supported
    assert models["ollama/qwen3:0.6b"].path == str(ollama / "blobs" / "sha256-aaa")
    assert models["ollama/someone/tuned:latest"].architecture == "gemma3"
    assert not models["ollama/mlxonly:latest"].supported


def test_public_listing_never_leaks_local_paths(lmstudio, ollama):
    archs = frozenset({"qwen3"})
    for m in local_library.scan_lmstudio(lmstudio, archs) + local_library.scan_ollama(ollama, archs):
        public = m.public()
        assert "path" not in public
        assert str(lmstudio.parent) not in json.dumps(public)


def test_ollama_blob_without_suffix_loads_as_gguf(ollama):
    blob = ollama / "blobs" / "sha256-aaa"
    assert gguf_load_args(str(blob)) == (str(blob.parent), {"gguf_file": "sha256-aaa"})
    assert gguf_load_args(str(ollama)) == (str(ollama), {})
    assert gguf_metadata(str(blob)) == ("qwen3", "Q4_K_M")


# 名字里别带 gemma：pytest 的临时目录名含测试名，会被路径名规则误认成 Gemma
def test_bf16_follows_gguf_architecture(ollama):
    mps = torch.device("mps")
    assert gemma_runtime_dtype(mps, str(ollama / "blobs" / "sha256-bbb"), torch.float16) == torch.bfloat16
    assert gemma_runtime_dtype(mps, str(ollama / "blobs" / "sha256-aaa"), torch.float16) == torch.float16
    assert gemma_runtime_dtype(torch.device("cpu"), str(ollama / "blobs" / "sha256-bbb"), torch.float32) == torch.float32


@pytest.fixture
def configured(lmstudio, ollama, monkeypatch, tmp_path):
    monkeypatch.setenv("LMSTUDIO_MODELS_DIR", str(lmstudio))
    monkeypatch.setenv("OLLAMA_MODELS", str(ollama))
    extra = _write_gguf(tmp_path / "loose" / "mine.gguf")
    monkeypatch.setattr(local_library, "supported_architectures", lambda: frozenset({"qwen3", "gemma3"}))
    found = local_library.configure(True, [str(extra)])
    yield found
    local_library.configure(False, [])


def test_configure_registers_usable_models(configured):
    from backend.models.class_register import REGISTERED_MODELS

    ids = {m.id for m in configured if m.supported}
    assert {"ollama/qwen3:0.6b", "file/mine.gguf"} <= ids
    assert ids <= set(REGISTERED_MODELS)
    assert local_library.is_enabled()
    assert local_library.get("ollama/qwen3:0.6b").source == "ollama"


def test_analyze_accepts_local_ids_and_explains_unsupported(configured, monkeypatch):
    from backend.api.analyze import _validate_and_prepare_request

    monkeypatch.setattr("backend.platform.app_context.get_app_context",
                        lambda **_: SimpleNamespace(base_model_id="qwen3-0.6b"))

    model, text, err, status = _validate_and_prepare_request({"model": "ollama/qwen3:0.6b", "text": "hi"})
    assert (model, err) == ("ollama/qwen3:0.6b", None)
    _, _, err, status = _validate_and_prepare_request({"model": "lmstudio/mlx-community/Qwen3-0.6B-4bit", "text": "hi"})
    assert status == 400 and "MLX" in err
    _, _, err, status = _validate_and_prepare_request({"model": "ollama/nope:1b", "text": "hi"})
    assert status == 400 and "Unknown base model" in err


@pytest.mark.parametrize("origin, ok", [
    (None, True),
    ("chrome-extension://abcdefghijklmnop", True),
    ("safari-web-extension://1234-5678", True),
    ("http://127.0.0.1:5001", True),
    ("http://localhost:8080", True),
    ("https://example.com", False),
    ("http://127.0.0.1.evil.example", False),
])
def test_listing_only_for_extensions_and_local_pages(configured, origin, ok):
    from backend.api.local_models import list_local_models

    headers = {"Origin": origin} if origin else {}
    with Flask(__name__).test_request_context("/api/local-models", headers=headers):
        body, status = list_local_models()
    assert status == (200 if ok else 403)
    assert ok == any(m["id"] == "ollama/qwen3:0.6b" for m in body.get("models", []))
