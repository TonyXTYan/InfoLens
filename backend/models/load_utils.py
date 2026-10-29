"""HuggingFace 模型下载与加载：下载独立，加载仅考虑本地"""

import json
import os
from typing import Callable, TypeVar

T = TypeVar("T")

# 与 transformers 的 checkpoint 命名一致
_SAFE_WEIGHTS = "model.safetensors"
_SAFE_WEIGHTS_INDEX = "model.safetensors.index.json"
_WEIGHTS = "pytorch_model.bin"
_WEIGHTS_INDEX = "pytorch_model.bin.index.json"


def _is_model_cache_complete(local_path: str) -> bool:
    """
    本地检查模型权重是否完整。与 transformers 的 _get_resolved_checkpoint_files 逻辑一致。
    """
    def _p(f: str) -> str:
        return os.path.join(local_path, f)

    if os.path.isfile(_p(_SAFE_WEIGHTS)):
        return True
    index_file = _p(_SAFE_WEIGHTS_INDEX)
    if os.path.isfile(index_file):
        with open(index_file) as f:
            index = json.load(f)
        shards = set(index.get("weight_map", {}).values())
        return all(os.path.isfile(_p(s)) for s in shards)
    if os.path.isfile(_p(_WEIGHTS)):
        return True
    index_file = _p(_WEIGHTS_INDEX)
    if os.path.isfile(index_file):
        with open(index_file) as f:
            index = json.load(f)
        shards = set(index.get("weight_map", {}).values())
        return all(os.path.isfile(_p(s)) for s in shards)
    return False


def ensure_model_local(model_path: str, *, force_download: bool = False) -> str:
    """
    确保模型在本地可用，返回本地路径。
    - 本地目录：直接返回
    - HuggingFace ID：优先用本地缓存（不联网），缓存不完整时 force_download 可触发下载
    """
    if os.path.isdir(model_path):
        return model_path
    if "/" in model_path and not os.path.exists(model_path):
        from huggingface_hub import snapshot_download

        if force_download:
            return snapshot_download(model_path)
        try:
            path = snapshot_download(model_path, local_files_only=True)
            if not _is_model_cache_complete(path):
                return snapshot_download(model_path)
            return path
        except Exception:
            try:
                return snapshot_download(model_path)
            except Exception as download_err:
                cache_dir = f"models--{model_path.replace('/', '--')}"
                raise RuntimeError(
                    f"无法从 Hugging Face 下载模型 {model_path!r}: {download_err}。"
                    f"若此前下载中断，可删除缓存目录 ~/.cache/huggingface/hub/{cache_dir} 后重试。"
                ) from download_err
    return model_path


GGUF_MAGIC = b"GGUF"


def is_gguf_file(path: str) -> bool:
    """按文件头认 GGUF：LM Studio 是 *.gguf，Ollama 的 blob 没有后缀（sha256-…）。"""
    try:
        with open(path, "rb") as f:
            return f.read(4) == GGUF_MAGIC
    except OSError:
        return False


def gguf_load_args(model_path: str) -> tuple[str, dict]:
    """GGUF 单文件 → (所在目录, {"gguf_file": 文件名})，交给 from_pretrained；其它路径原样。
    transformers 会把 GGUF 反量化成普通权重，内存按加载 dtype 算。"""
    if os.path.isfile(model_path) and is_gguf_file(model_path):
        return os.path.dirname(model_path), {"gguf_file": os.path.basename(model_path)}
    return model_path, {}


def gguf_metadata(path: str) -> tuple[str | None, str | None]:
    """(general.architecture, 量化类型如 Q4_K_M)。只读文件头与张量表，不读权重。"""
    from gguf import GGUFReader, LlamaFileType

    reader = GGUFReader(path)
    arch_field = reader.fields.get("general.architecture")
    arch = arch_field.contents() if arch_field is not None else None
    ft_field = reader.fields.get("general.file_type")
    quant = None
    if ft_field is not None:
        try:
            quant = LlamaFileType(int(ft_field.contents())).name.removeprefix("MOSTLY_")
        except ValueError:
            quant = str(ft_field.contents())
    return arch, quant


def resolve_and_load(model_path: str, loader: Callable[[str, bool], T]) -> T:
    """
    先确保模型本地可用，再加载。加载时始终使用 local_files_only=True。
    """
    path = ensure_model_local(model_path)
    return loader(path, True)
