"""docx -> sanitised HTML (mammoth + allowlist sanitizer) and its cache."""
from __future__ import annotations

import pytest

from app.docview import cache, docx_html
from app.docview.docx_html import sanitize_html
from test_docview_helpers import make_docx, patch_settings, write_garbage


@pytest.fixture(autouse=True)
def _env(tmp_path, monkeypatch):
    patch_settings(monkeypatch, data_dir=str(tmp_path / "data"))
    cache.clear_memory()
    yield
    cache.clear_memory()


def test_docx_to_html(tmp_path):
    p = make_docx(str(tmp_path / "spec.docx"))
    html = docx_html.convert_docx(p)["html"]
    assert "<h1>Darbu apraksts</h1>" in html
    assert "<table>" in html and "<td><p>Rozete</p></td>" in html
    assert "<strong>bold</strong>" in html
    # the script-ish text survives only as escaped text
    assert "<script" not in html.lower()
    assert "&lt;script&gt;alert('x')&lt;/script&gt; &amp; teksts" in html
    assert 'href="https://example.com/spec"' in html and 'rel="noopener noreferrer nofollow"' in html
    assert "javascript:" not in html.lower()
    assert '<img src="data:image/png;base64,' in html


@pytest.mark.parametrize("dirty,clean", [
    ('<p onclick="x()">a</p>', "<p>a</p>"),
    ("<script>alert(1)</script><p>x</p>", "<p>x</p>"),
    ("<SCRIPT>alert(1)</SCRIPT>ok", "ok"),
    ("<style>p{color:red}</style>ok", "ok"),
    ('<iframe src="https://evil"><p>in</p></iframe>ok', "ok"),
    ("<svg><script>1</script><circle/></svg>ok", "ok"),
    ('<a href="javascript:alert(1)">j</a>', "<a>j</a>"),
    ('<a href=" JaVaScRiPt:alert(1)">j</a>', "<a>j</a>"),
    ('<a href="java\tscript:alert(1)">j</a>', "<a>j</a>"),
    ('<a href="data:text/html,x">j</a>', "<a>j</a>"),
    ('<a href="https://ok.lv/?a=1&amp;b=2">k</a>',
     '<a href="https://ok.lv/?a=1&amp;b=2" rel="noopener noreferrer nofollow" target="_blank">k</a>'),
    ('<a href="https://ok.lv/&quot;onmouseover=x()">q</a>', "<a>q</a>"),
    ('<img src="https://tracker/x.png">', ""),
    ('<img src="data:image/svg+xml;base64,PHN2Zz4=">', ""),
    ('<img src="data:image/png;base64,AAAA" onerror="x()" alt="a&quot;b">',
     '<img src="data:image/png;base64,AAAA" alt="a&quot;b">'),
    ('<td colspan="2" style="x" rowspan="x">c</td>', '<td colspan="2">c</td>'),
    ("<div><form><input value=1>txt</form></div>", "txt"),
    ("<!-- secret --><p>a<br/>b</p>", "<p>a<br>b</p>"),
    ("<p>unclosed <b>bold", "<p>unclosed <b>bold</b></p>"),
    ("<p>a</b></p>", "<p>a</p>"),
    ("&lt;script&gt;", "&lt;script&gt;"),
    ('<span style="color:red" class="x">s</span>', "<span>s</span>"),
])
def test_sanitizer(dirty, clean):
    assert sanitize_html(dirty) == clean


def test_docx_cache_and_unreadable(tmp_path):
    p = make_docx(str(tmp_path / "c.docx"))
    c0 = cache.stats["conversions"]
    a = docx_html.load_html(p)["html"]
    cache.clear_memory()
    b = docx_html.load_html(p)["html"]
    assert a == b and cache.stats["conversions"] == c0 + 1
    bad = write_garbage(str(tmp_path / "bad.docx"))
    with pytest.raises(cache.Unreadable):
        docx_html.load_html(bad)
