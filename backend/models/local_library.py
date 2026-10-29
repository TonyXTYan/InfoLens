"""本机 LM Studio / Ollama 已下载的模型：扫描后登记成 /api/analyze 可选的 model id。

run.py --local-models（扫两家默认目录）或 --local-model PATH（导入指定文件/目录）开启；默认关。
GGUF 交给 transformers 反量化后走与 HF 模型完全相同的 QwenLM 打分路径。
对外（/api/local-models）只给 id 与元数据，不给本机绝对路径。
"""
from __future__ import annotations

import json
import os
import threading
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable, Optional

from .load_utils import gguf_metadata, is_gguf_file

OLLAMA_MODEL_LAYER = "application/vnd.ollama.image.model"
OLLAMA_LIBRARY_HOSTS = {"registry.ollama.ai", "ollama.com"}
MLX_REASON = "MLX weights aren't supported; download the GGUF version of this model in LM Studio"


@dataclass(frozen=True)
class LocalModel:
    id: str  # lmstudio/<publisher>/<repo>/<file>.gguf | ollama/<name>:<tag> | file/<name>
    source: str  # lmstudio | ollama | file
    name: str
    format: str  # gguf | mlx | safetensors
    size_bytes: int
    architecture: Optional[str]
    quantization: Optional[str]
    supported: bool
    reason: Optional[str]
    path: str  # 仅本进程加载用，不出接口

    def public(self) -> dict:
        out = asdict(self)
        out.pop("path")
        return out


def lmstudio_roots() -> list[Path]:
    """LM Studio 可在设置里改模型目录；改过的用 LMSTUDIO_MODELS_DIR 或 --local-model 指过去。"""
    env = os.environ.get("LMSTUDIO_MODELS_DIR")
    if env:
        return [Path(env).expanduser()]
    home = Path.home()
    return [home / ".lmstudio" / "models", home / ".cache" / "lm-studio" / "models"]


def ollama_root() -> Path:
    return Path(os.environ.get("OLLAMA_MODELS") or Path.home() / ".ollama" / "models").expanduser()


def supported_architectures() -> frozenset[str]:
    """装着的 transformers 能反量化加载的 GGUF architecture；版本越新越多。"""
    try:
        from transformers.modeling_gguf_pytorch_utils import GGUF_SUPPORTED_ARCHITECTURES
    except ImportError:
        return frozenset()
    return frozenset(GGUF_SUPPORTED_ARCHITECTURES) - {"general", "tokenizer"}


def _gguf_model(model_id: str, source: str, name: str, path: Path, archs: frozenset[str]) -> LocalModel:
    base = dict(id=model_id, source=source, name=name, format="gguf", path=str(path),
                size_bytes=path.stat().st_size, architecture=None, quantization=None)
    if not is_gguf_file(str(path)):
        return LocalModel(**base, supported=False, reason="not a GGUF file")
    try:
        arch, quant = gguf_metadata(str(path))
    except Exception as exc:  # noqa: BLE001 - 坏文件只标不支持，不影响其它条目
        return LocalModel(**base, supported=False, reason=f"unreadable GGUF: {exc}")
    base.update(architecture=arch, quantization=quant)
    if arch not in archs:
        return LocalModel(**base, supported=False, reason=f"this transformers version can't load '{arch}' GGUF models")
    return LocalModel(**base, supported=True, reason=None)


def _folder_size(folder: Path) -> int:
    return sum(p.stat().st_size for p in folder.iterdir() if p.is_file())


def scan_lmstudio(root: Path, archs: frozenset[str]) -> list[LocalModel]:
    """<root>/<publisher>/<repo>/*.gguf；同层有 config.json + safetensors 的是 MLX 目录。"""
    out = []
    for path in sorted(root.rglob("*.gguf")):
        if path.name.lower().startswith("mmproj"):
            continue  # 多模态投影器，不是语言模型
        rel = path.relative_to(root).as_posix()
        out.append(_gguf_model(f"lmstudio/{rel}", "lmstudio", rel, path, archs))
    for config in sorted(root.rglob("config.json")):
        folder = config.parent
        if not any(folder.glob("*.safetensors")):
            continue
        try:
            arch = json.loads(config.read_text(encoding="utf-8")).get("model_type")
        except (OSError, ValueError):
            arch = None
        rel = folder.relative_to(root).as_posix()
        out.append(LocalModel(
            id=f"lmstudio/{rel}", source="lmstudio", name=rel, format="mlx", size_bytes=_folder_size(folder),
            architecture=arch, quantization=None, supported=False, reason=MLX_REASON, path=str(folder),
        ))
    return out


def _ollama_name(host: str, repo: list[str], tag: str) -> str:
    if host in OLLAMA_LIBRARY_HOSTS:
        repo = repo[1:] if repo[:1] == ["library"] else repo
        return f"{'/'.join(repo)}:{tag}"
    return f"{host}/{'/'.join(repo)}:{tag}"


def scan_ollama(root: Path, archs: frozenset[str]) -> list[LocalModel]:
    """manifests/<host>/<namespace>/<model>/<tag> 里 mediaType 为 image.model 的层 → blobs/sha256-<hex>。"""
    out: dict[str, LocalModel] = {}
    for manifests in (root / "manifests", root / "manifests-v2"):
        if not manifests.is_dir():
            continue
        for manifest in sorted(p for p in manifests.rglob("*") if p.is_file()):
            parts = manifest.relative_to(manifests).parts
            if len(parts) < 3:
                continue
            host, *repo, tag = parts
            name = _ollama_name(host, repo, tag)
            model_id = f"ollama/{name}"
            if model_id in out:
                continue
            try:
                layers = json.loads(manifest.read_text(encoding="utf-8")).get("layers", [])
            except (OSError, ValueError):
                continue
            layer = next((l for l in layers if l.get("mediaType") == OLLAMA_MODEL_LAYER), None)
            if layer is None:
                size = sum(int(l.get("size", 0)) for l in layers)
                out[model_id] = LocalModel(
                    id=model_id, source="ollama", name=name, format="other", size_bytes=size, architecture=None,
                    quantization=None, supported=False, reason="not stored as a GGUF model", path="",
                )
                continue
            blob = root / "blobs" / str(layer.get("digest", "")).replace(":", "-")
            if not blob.is_file():
                continue
            out[model_id] = _gguf_model(model_id, "ollama", name, blob, archs)
    return list(out.values())


def scan_paths(paths: Iterable[Path], archs: frozenset[str]) -> list[LocalModel]:
    """--local-model：GGUF 文件、含 GGUF 的目录，或 HF 格式目录（config.json + safetensors）。"""
    out = []
    for path in paths:
        if path.is_file():
            out.append(_gguf_model(f"file/{path.name}", "file", path.name, path, archs))
        elif (path / "config.json").is_file() and any(path.glob("*.safetensors")):
            out.append(LocalModel(
                id=f"file/{path.name}", source="file", name=path.name, format="safetensors",
                size_bytes=_folder_size(path), architecture=None, quantization=None,
                supported=True, reason=None, path=str(path),
            ))
        elif path.is_dir():
            for gguf in sorted(path.rglob("*.gguf")):
                if not gguf.name.lower().startswith("mmproj"):
                    rel = gguf.relative_to(path).as_posix()
                    out.append(_gguf_model(f"file/{path.name}/{rel}", "file", rel, gguf, archs))
    return out


_lock = threading.Lock()
_scan_defaults = False
_extra_paths: tuple[Path, ...] = ()
_models: dict[str, LocalModel] = {}


def configure(scan_defaults: bool, extra_paths: Iterable[str] = ()) -> list[LocalModel]:
    """run.py 启动时调一次；两项都没给则保持关闭。"""
    global _scan_defaults, _extra_paths
    _scan_defaults = scan_defaults
    _extra_paths = tuple(Path(p).expanduser().resolve() for p in extra_paths)
    return rescan() if is_enabled() else []


def is_enabled() -> bool:
    return _scan_defaults or bool(_extra_paths)


def rescan() -> list[LocalModel]:
    archs = supported_architectures()
    found: list[LocalModel] = []
    if _scan_defaults:
        for root in lmstudio_roots():
            if root.is_dir():
                found += scan_lmstudio(root, archs)
        if ollama_root().is_dir():
            found += scan_ollama(ollama_root(), archs)
    found += scan_paths(_extra_paths, archs)
    unique = {m.id: m for m in found}
    with _lock:
        _models.clear()
        _models.update(unique)
    _register([m for m in unique.values() if m.supported])
    return list(unique.values())


def listed() -> list[LocalModel]:
    with _lock:
        return list(_models.values())


def get(model_id: str) -> Optional[LocalModel]:
    with _lock:
        return _models.get(model_id)


def _register(models: list[LocalModel]) -> None:
    """每个可用模型登记一个 QwenLM 子类；同 id 换了文件（如 ollama pull 更新了 tag）则换类并卸掉旧实例。"""
    from backend.core.language_checker import QwenLM
    from backend.models.class_register import REGISTERED_MODELS, register_model
    from backend.models.model_manager import project_registry

    for m in models:
        old = REGISTERED_MODELS.get(m.id)
        if old is not None and getattr(old, "_local_path", None) == m.path:
            continue
        if old is not None:
            project_registry.unload(m.id)

        def __init__(self, _path=m.path, _id=m.id):
            QwenLM.__init__(self, model_path=_path, model_name=_id)

        cls = type("LocalLM", (QwenLM,), {"__init__": __init__, "_local_path": m.path})
        register_model(m.id)(cls)
