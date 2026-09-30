"""Conversion cache for the viewer: ``${DATA_DIR}/cache/view/<sha>.<ext>`` + a small in-process LRU.

Key = sha256(converter tag + version + absolute path + mtime_ns + size). A new document version
(new path) or a replaced file (new mtime/size) gets a new key, so entries never need invalidation;
stale ones are just unused. Conversion runs lazily on first request under a per-key lock, so
concurrent first requests convert once. Failed conversions are cached too (``.err.json``) so a
corrupt upload is not re-parsed on every request.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import tempfile
import threading
from collections import OrderedDict
from typing import Any, Callable

from .. import config

# Counters used by tests / diagnostics.
stats = {"conversions": 0, "disk_hits": 0, "memory_hits": 0}

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()
_mem: "OrderedDict[str, Any]" = OrderedDict()
_mem_guard = threading.Lock()
_MEM_MAX = max(1, int(os.environ.get("DOCVIEW_MEMORY_CACHE", "4") or 4))


class Unreadable(Exception):
    """The file exists but cannot be converted (corrupt, encrypted, wrong format)."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def cache_dir() -> str:
    d = os.path.join(config.settings.data_dir, "cache", "view")
    os.makedirs(d, exist_ok=True)
    return d


def cache_key(tag: str, path: str) -> str:
    st = os.stat(path)
    raw = f"{tag}\0{os.path.abspath(path)}\0{st.st_mtime_ns}\0{st.st_size}"
    return hashlib.sha256(raw.encode()).hexdigest()


def _lock_for(key: str) -> threading.Lock:
    with _locks_guard:
        lk = _locks.get(key)
        if lk is None:
            lk = _locks[key] = threading.Lock()
        return lk


def _mem_get(key: str) -> Any:
    with _mem_guard:
        if key in _mem:
            _mem.move_to_end(key)
            return _mem[key]
    return None


def _mem_put(key: str, value: Any) -> None:
    with _mem_guard:
        _mem[key] = value
        _mem.move_to_end(key)
        while len(_mem) > _MEM_MAX:
            _mem.popitem(last=False)


def clear_memory() -> None:
    with _mem_guard:
        _mem.clear()


def _atomic_write(path: str, data: bytes) -> None:
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def get_or_build(key: str, suffix: str, build: Callable[[], Any],
                 dump: Callable[[Any], bytes], load: Callable[[bytes], Any],
                 prepare: Callable[[Any], Any] = lambda v: v) -> Any:
    """Return the prepared value for ``key``: memory -> disk -> build (once, under a lock)."""
    hit = _mem_get(key)
    if hit is not None:
        stats["memory_hits"] += 1
        return hit
    with _lock_for(key):
        hit = _mem_get(key)
        if hit is not None:
            stats["memory_hits"] += 1
            return hit
        d = cache_dir()
        path = os.path.join(d, f"{key}{suffix}")
        err_path = os.path.join(d, f"{key}.err.json")
        if os.path.exists(err_path):
            try:
                with open(err_path, "rb") as f:
                    raise Unreadable(json.loads(f.read()).get("reason") or "unreadable")
            except (OSError, ValueError):
                pass
        value = None
        if os.path.exists(path):
            try:
                with open(path, "rb") as f:
                    value = load(f.read())
                stats["disk_hits"] += 1
            except Exception:  # noqa: BLE001 - corrupt cache entry: rebuild
                value = None
        if value is None:
            stats["conversions"] += 1
            try:
                value = build()
            except Unreadable as e:
                _atomic_write(err_path, json.dumps({"reason": e.reason}).encode())
                raise
            _atomic_write(path, dump(value))
        prepared = prepare(value)
        _mem_put(key, prepared)
        return prepared


def gzip_json_dump(value: Any) -> bytes:
    return gzip.compress(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode(), compresslevel=5)


def gzip_json_load(data: bytes) -> Any:
    return json.loads(gzip.decompress(data))
