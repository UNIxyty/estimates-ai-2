"""Resolve viewer ids to files on disk. Web has already authorised the user; this only looks up paths."""
from __future__ import annotations

import mimetypes
import os
import uuid
from dataclasses import dataclass

from .. import config, db

MIME_BY_EXT = {
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xls": "application/vnd.ms-excel",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pdf": "application/pdf",
}


class ViewError(Exception):
    def __init__(self, status: int, error: str, reason: str | None = None) -> None:
        super().__init__(reason or error)
        self.status, self.error, self.reason = status, error, reason

    def body(self) -> dict:
        b = {"error": self.error}
        if self.reason:
            b["reason"] = self.reason
        return b


@dataclass(frozen=True)
class Target:
    kind: str           # file | document
    id: str
    ext: str            # ext of the file being *viewed* (xls -> xlsx via work_path)
    view_path: str      # what the converters read
    raw_path: str       # original bytes (pdf.js / download)
    raw_ext: str
    name: str
    mime: str


def abs_path(p: str) -> str:
    if os.path.isabs(p):
        return p
    return os.path.join(config.settings.data_dir, p)


def _check_id(id_: str) -> str:
    try:
        return str(uuid.UUID(str(id_)))
    except (ValueError, TypeError, AttributeError):
        raise ViewError(400, "bad_id", "id must be a uuid") from None


def resolve(kind: str, id_: str, *, need_view: bool = True) -> Target:
    id_ = _check_id(id_)
    if kind == "file":
        f = db.fetchone(
            "SELECT id, ext, mime, original_name, stored_path, work_path FROM files "
            "WHERE id = %s AND deleted_at IS NULL", (id_,))
        if not f:
            raise ViewError(404, "not_found")
        ext = (f["ext"] or "").lower()
        raw = abs_path(f["stored_path"])
        view, view_ext = raw, ext
        if ext == "xls":
            if f["work_path"]:
                view, view_ext = abs_path(f["work_path"]), "xlsx"
            elif need_view:
                raise ViewError(409, "not_ready", "xls conversion has not finished")
        elif f["work_path"]:
            view = abs_path(f["work_path"])
        mime = f["mime"] or MIME_BY_EXT.get(ext) or mimetypes.guess_type(f["original_name"])[0] \
            or "application/octet-stream"
        t = Target("file", id_, view_ext, view, raw, ext, f["original_name"], mime)
    elif kind == "document":
        d = db.fetchone("SELECT id, name, stored_path FROM documents WHERE id = %s", (id_,))
        if not d:
            raise ViewError(404, "not_found")
        p = abs_path(d["stored_path"])
        ext = os.path.splitext(p)[1].lstrip(".").lower() or "xlsx"
        name = d["name"] if d["name"].lower().endswith(f".{ext}") else f"{d['name']}.{ext}"
        t = Target("document", id_, ext, p, p, ext, name, MIME_BY_EXT.get(ext, "application/octet-stream"))
    else:
        raise ViewError(400, "bad_kind", "kind must be file or document")
    path = t.view_path if need_view else t.raw_path
    if not os.path.isfile(path):
        raise ViewError(404, "not_found", "file missing on disk")
    return t
