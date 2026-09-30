"""docx -> sanitised HTML for the viewer (mammoth + a small allowlist sanitizer).

The sanitizer is html.parser based: only allowlisted tags/attributes survive, the contents of
script/style/iframe/object/... are dropped entirely, links keep http(s) hrefs only, images keep
``data:image/(png|jpeg|gif|webp|bmp)`` sources only (mammoth inlines docx images that way), and
all text/attribute values are re-escaped.
"""
from __future__ import annotations

import html
import re
import zipfile
from html.parser import HTMLParser

import mammoth

from . import cache

CONVERTER_VERSION = 1

ALLOWED_TAGS = {
    "p", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tfoot", "tr", "td", "th",
    "ul", "ol", "li", "strong", "em", "b", "i", "u", "s", "sup", "sub", "br", "span", "a", "img",
    "blockquote", "hr", "caption",
}
VOID_TAGS = {"br", "img", "hr"}
# Tags whose whole content is dropped, not just the tag.
DROP_CONTENT = {"script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "math",
                "frame", "frameset", "applet", "head", "title", "textarea", "select", "xml"}
ALLOWED_ATTRS = {
    "a": {"href"},
    "img": {"src", "alt"},
    "td": {"colspan", "rowspan"},
    "th": {"colspan", "rowspan"},
    "ol": {"start"},
}
_SAFE_HREF = re.compile(r"^https?://[^\s\"'<>]+$", re.I)
_SAFE_IMG = re.compile(r"^data:image/(png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=\s]+$", re.I)
_CTRL = re.compile(r"[\x00-\x20\x7f]+")
_INT = re.compile(r"^\d{1,4}$")


class _Sanitizer(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.drop_depth = 0
        self.open: list[str] = []

    def _attrs(self, tag: str, attrs: list[tuple[str, str | None]]) -> str | None:
        allowed = ALLOWED_ATTRS.get(tag, set())
        parts = []
        for name, value in attrs:
            name = (name or "").lower()
            if name not in allowed or value is None:
                continue
            v = value.strip()
            if name == "href":
                if _CTRL.search(v) or not _SAFE_HREF.match(v):
                    continue
            elif name == "src":
                if not _SAFE_IMG.match(v):
                    continue
                v = re.sub(r"\s+", "", v)
            elif name in ("colspan", "rowspan", "start"):
                if not _INT.match(v):
                    continue
            parts.append(f'{name}="{html.escape(v, quote=True)}"')
        if tag == "img" and not any(p.startswith("src=") for p in parts):
            return None  # external / unsafe image: drop the element
        if tag == "a" and any(p.startswith("href=") for p in parts):
            parts.append('rel="noopener noreferrer nofollow" target="_blank"')
        return (" " + " ".join(parts)) if parts else ""

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in DROP_CONTENT:
            if tag not in VOID_TAGS:
                self.drop_depth += 1
            return
        if self.drop_depth or tag not in ALLOWED_TAGS:
            return
        a = self._attrs(tag, attrs)
        if a is None:
            return
        self.out.append(f"<{tag}{a}>")
        if tag not in VOID_TAGS:
            self.open.append(tag)

    def handle_startendtag(self, tag, attrs):
        tag = tag.lower()
        if tag in DROP_CONTENT or self.drop_depth or tag not in ALLOWED_TAGS:
            return
        a = self._attrs(tag, attrs)
        if a is None:
            return
        if tag in VOID_TAGS:
            self.out.append(f"<{tag}{a}>")
        else:
            self.out.append(f"<{tag}{a}></{tag}>")

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in DROP_CONTENT:
            if self.drop_depth:
                self.drop_depth -= 1
            return
        if self.drop_depth or tag not in ALLOWED_TAGS or tag in VOID_TAGS:
            return
        if tag in self.open:
            # close anything left open inside it, keeping output well-formed
            while self.open:
                t = self.open.pop()
                self.out.append(f"</{t}>")
                if t == tag:
                    break

    def handle_data(self, data):
        if not self.drop_depth:
            self.out.append(html.escape(data, quote=False))

    # comments, doctype, processing instructions: dropped
    def handle_comment(self, data):
        pass

    def handle_decl(self, decl):
        pass

    def handle_pi(self, data):
        pass

    def unknown_decl(self, data):
        pass

    def result(self) -> str:
        self.close()
        while self.open:
            self.out.append(f"</{self.open.pop()}>")
        return "".join(self.out)


def sanitize_html(src: str) -> str:
    s = _Sanitizer()
    s.feed(src)
    return s.result()


def convert_docx(path: str) -> dict:
    try:
        with open(path, "rb") as f:
            result = mammoth.convert_to_html(f)
    except zipfile.BadZipFile:
        raise cache.Unreadable("not a valid docx file (bad zip)") from None
    except KeyError as e:
        raise cache.Unreadable(f"not a valid docx file: missing {e}") from None
    except Exception as e:  # noqa: BLE001 - mammoth/lxml raise many types on corrupt files
        raise cache.Unreadable(f"cannot read document: {type(e).__name__}: {e}"[:300]) from None
    return {"html": sanitize_html(result.value or ""),
            "warnings": [m.message for m in result.messages][:20]}


def load_html(path: str) -> dict:
    key = cache.cache_key(f"docx-v{CONVERTER_VERSION}", path)
    return cache.get_or_build(
        key, ".html",
        lambda: convert_docx(path),
        lambda v: v["html"].encode("utf-8"),
        lambda b: {"html": b.decode("utf-8"), "warnings": []},
    )
