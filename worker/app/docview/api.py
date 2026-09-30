"""Internal DocViewer endpoints (web -> worker, ``X-Internal-Token`` required).

Errors are JSON ``{error, reason?}``:
400 bad_id|bad_kind|bad_param, 401 unauthorized, 404 not_found, 409 not_ready (xls not converted yet),
415 unsupported (wrong viewer for the file type), 422 unreadable (corrupt file -> viewer failed state).
"""
from __future__ import annotations

import hmac
import json
import logging
import os
from typing import Any, Callable

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import Response

from .. import config
from . import cache, docx_html, markers, xlsx_json
from .resolve import ViewError, resolve

log = logging.getLogger(__name__)


def require_internal_token(x_internal_token: str | None = Header(default=None)) -> None:
    expected = config.settings.internal_token
    if not expected:
        if os.environ.get("ALLOW_NO_INTERNAL_TOKEN") == "1":
            return
        raise HTTPException(status_code=401, detail={"error": "unauthorized"})
    if not x_internal_token or not hmac.compare_digest(x_internal_token.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail={"error": "unauthorized"})


router = APIRouter(prefix="/internal/view", dependencies=[Depends(require_internal_token)])


def _json(body: Any, status: int = 200) -> Response:
    return Response(json.dumps(body, ensure_ascii=False, separators=(",", ":"), default=str),
                    status_code=status, media_type="application/json")


def _handle(fn: Callable[[], Any]) -> Response:
    try:
        return _json(fn())
    except ViewError as e:
        return _json(e.body(), e.status)
    except cache.Unreadable as e:
        return _json({"error": "unreadable", "reason": e.reason}, 422)
    except FileNotFoundError:
        return _json({"error": "not_found", "reason": "file missing on disk"}, 404)


def _int_param(req: Request, name: str, default: int | None) -> int | None:
    raw = req.query_params.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        raise ViewError(400, "bad_param", f"{name} must be an integer") from None


def _xlsx_target(kind: str, id_: str):
    t = resolve(kind, id_)
    if t.ext != "xlsx":
        raise ViewError(415, "unsupported", f"{t.ext} has no sheet view")
    return t


@router.get("/sheets")
def sheets(kind: str, id: str) -> Response:
    def run():
        t = _xlsx_target(kind, id)
        wb = xlsx_json.load(t.view_path)
        meta = xlsx_json.workbook_meta(wb)
        if kind == "document":
            counts = markers.marker_counts(t.id)
            empty = {"web": 0, "check": 0, "no_price": 0, "edited": 0, "flagged": 0}
            for s in meta["sheets"]:
                s["marker_counts"] = counts.get(s["name"], dict(empty))
        return {"kind": kind, "id": t.id, "name": t.name, **meta}
    return _handle(run)


@router.get("/rows")
def rows(request: Request, kind: str, id: str) -> Response:
    def run():
        offset = _int_param(request, "offset", 0)
        limit = _int_param(request, "limit", 200)
        around = _int_param(request, "around", None)
        if offset < 0 or limit < 1:
            raise ViewError(400, "bad_param", "offset must be >= 0 and limit >= 1")
        filter_ = (request.query_params.get("filter") or "all").lower()
        if filter_ not in xlsx_json.FILTERS:
            raise ViewError(400, "bad_param", f"filter must be one of {', '.join(xlsx_json.FILTERS)}")
        q = request.query_params.get("q") or None
        t = _xlsx_target(kind, id)
        wb = xlsx_json.load(t.view_path)
        si = xlsx_json.find_sheet(wb, request.query_params.get("sheet"))
        if si is None:
            raise ViewError(404, "not_found", "no such sheet")
        mk = None
        if kind == "document":
            mk = markers.load_markers(t.id, wb.model["sheets"][si]["name"])
        return xlsx_json.query_rows(wb, si, offset=offset, limit=limit, filter_=filter_, q=q,
                                    around=around, markers=mk)
    return _handle(run)


@router.get("/html")
def html(kind: str, id: str) -> Response:
    def run():
        if kind != "file":
            raise ViewError(415, "unsupported", "html view is for docx knowledge files")
        t = resolve(kind, id)
        if t.ext != "docx":
            raise ViewError(415, "unsupported", f"{t.ext} has no html view")
        return {"html": docx_html.load_html(t.view_path)["html"]}
    return _handle(run)


@router.get("/raw-path")
def raw_path(kind: str, id: str) -> Response:
    def run():
        t = resolve(kind, id, need_view=False)
        return {"path": t.raw_path, "name": t.name, "mime": t.mime}
    return _handle(run)
