"""本机 LM Studio / Ollama 模型列表（run.py --local-models / --local-model 开启）。

CORS 是 *：任何网页都能打本机服务。模型清单会暴露本机装了什么，本机模型也可能很大，
所以列表与用本机模型分析只认扩展页、本机页面和不带 Origin 的客户端（curl、同源 GET）。
"""
from urllib.parse import urlparse

from flask import request

from backend.models import local_library

EXTENSION_ORIGIN_PREFIXES = ("chrome-extension://", "moz-extension://", "safari-web-extension://")
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


def local_origin_allowed() -> bool:
    origin = request.headers.get("Origin")
    if not origin:
        return True
    if origin.startswith(EXTENSION_ORIGIN_PREFIXES):
        return True
    return urlparse(origin).hostname in LOCAL_HOSTS


def list_local_models(rescan=False):
    if not local_library.is_enabled():
        return {"success": True, "enabled": False, "models": []}, 200
    if not local_origin_allowed():
        return {"success": False, "message": "Local models are only listed for the browser extension and local pages"}, 403
    models = local_library.rescan() if rescan else local_library.listed()
    return {"success": True, "enabled": True, "models": [m.public() for m in models]}, 200
