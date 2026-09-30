"""Tiny formula evaluator used only when a formula cell has no cached value.

Workbooks written by openpyxl (our own produced estimates, before any recalculation) carry
formulas without cached results, so ``data_only=True`` returns ``None`` for every total.
This evaluates the subset estimates use: arithmetic, comparison, ``&``, percent, cell refs
(same or other sheet, ``$`` anchors), ranges, and SUM / MIN / MAX / AVERAGE / COUNT /
PRODUCT / ROUND / ROUNDUP / ROUNDDOWN / ABS / IF / IFERROR / SUMPRODUCT / CEILING / FLOOR / INT.
Anything else yields ``None`` (the cell then shows empty with the formula flag).
"""
from __future__ import annotations

import math
import re
from typing import Any, Callable

from openpyxl.utils.cell import column_index_from_string

_TOKEN_RE = re.compile(r"""
    (?P<ws>\s+)
  | (?P<str>"(?:[^"]|"")*")
  | (?P<ref>(?:(?:'(?:[^']|'')+'|[A-Za-z_][\w.]*)!)?\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)
  | (?P<num>\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)
  | (?P<func>[A-Za-z_][\w.]*\s*\()
  | (?P<bool>TRUE|FALSE)
  | (?P<op><>|<=|>=|[-+*/^&=<>%(),;:])
""", re.VERBOSE)

_CELL_RE = re.compile(r"\$?([A-Za-z]{1,3})\$?(\d+)")


class FormulaError(Exception):
    pass


class _TooDeep(Exception):
    """Dependency chain deeper than the recursion limit (not an evaluation error)."""


DEFERRED = object()


def _tokenise(src: str) -> list[tuple[str, str]]:
    pos, out = 0, []
    while pos < len(src):
        m = _TOKEN_RE.match(src, pos)
        if not m:
            raise FormulaError(f"bad token at {pos}")
        pos = m.end()
        kind = m.lastgroup
        if kind == "ws":
            continue
        out.append((kind, m.group(kind)))
    return out


def _num(v: Any) -> float:
    if v is None or v == "":
        return 0.0
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v.replace(",", "."))
        except ValueError:
            raise FormulaError("#VALUE!") from None
    raise FormulaError("#VALUE!")


def _flat(args: list[Any]) -> list[Any]:
    out: list[Any] = []
    for a in args:
        if isinstance(a, _Range):
            out.extend(a.values())
        elif isinstance(a, list):
            out.extend(a)
        else:
            out.append(a)
    return out


def _nums(args: list[Any]) -> list[float]:
    return [float(v) for v in _flat(args) if isinstance(v, (int, float)) and not isinstance(v, bool)]


def _round(x: float, n: float, mode: str = "half") -> float:
    n = int(n)
    f = 10 ** n
    if mode == "up":
        return math.copysign(math.ceil(abs(x) * f - 1e-9) / f, x)
    if mode == "down":
        return math.copysign(math.floor(abs(x) * f + 1e-9) / f, x)
    return math.copysign(math.floor(abs(x) * f + 0.5 + 1e-9) / f, x)


def _if(args):
    cond = args[0]
    if isinstance(cond, str):
        cond = bool(cond)
    return (args[1] if len(args) > 1 else True) if cond else (args[2] if len(args) > 2 else False)


def _sumproduct(args):
    arrays = [a.values() if isinstance(a, _Range) else [a] for a in args]
    if not arrays:
        return 0.0
    total = 0.0
    for tup in zip(*arrays):
        p = 1.0
        for v in tup:
            p *= v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0.0
        total += p
    return total


_FUNCS: dict[str, Callable[[list[Any]], Any]] = {
    "SUM": lambda a: sum(_nums(a)),
    "MIN": lambda a: min(_nums(a), default=0.0),
    "MAX": lambda a: max(_nums(a), default=0.0),
    "AVERAGE": lambda a: (sum(_nums(a)) / len(_nums(a))) if _nums(a) else _raise("#DIV/0!"),
    "COUNT": lambda a: float(len(_nums(a))),
    "COUNTA": lambda a: float(len([v for v in _flat(a) if v not in (None, "")])),
    "PRODUCT": lambda a: math.prod(_nums(a)) if _nums(a) else 0.0,
    "ROUND": lambda a: _round(_num(a[0]), _num(a[1]) if len(a) > 1 else 0),
    "ROUNDUP": lambda a: _round(_num(a[0]), _num(a[1]) if len(a) > 1 else 0, "up"),
    "ROUNDDOWN": lambda a: _round(_num(a[0]), _num(a[1]) if len(a) > 1 else 0, "down"),
    "ABS": lambda a: abs(_num(a[0])),
    "INT": lambda a: float(math.floor(_num(a[0]))),
    "CEILING": lambda a: math.ceil(_num(a[0]) / (_num(a[1]) or 1)) * (_num(a[1]) or 1) if len(a) > 1 else math.ceil(_num(a[0])),
    "FLOOR": lambda a: math.floor(_num(a[0]) / (_num(a[1]) or 1)) * (_num(a[1]) or 1) if len(a) > 1 else math.floor(_num(a[0])),
    "IF": _if,
    "SUMPRODUCT": _sumproduct,
}


def _raise(msg: str):
    raise FormulaError(msg)


class _Range:
    def __init__(self, ev: "Evaluator", sheet: str, r1: int, c1: int, r2: int, c2: int) -> None:
        self.ev, self.sheet = ev, sheet
        self.r1, self.c1, self.r2, self.c2 = min(r1, r2), min(c1, c2), max(r1, r2), max(c1, c2)

    def values(self) -> list[Any]:
        if (self.r2 - self.r1 + 1) * (self.c2 - self.c1 + 1) > 200_000:
            raise FormulaError("range too large")
        return [self.ev._value(self.sheet, r, c)
                for r in range(self.r1, self.r2 + 1) for c in range(self.c1, self.c2 + 1)]


class Evaluator:
    """Evaluates formulas against ``cells[sheet][(row, col)] -> raw value (formula str or literal)``.

    ``cached[sheet][(row, col)]`` holds values Excel already computed; they win when present.
    """

    def __init__(self, cells: dict[str, dict[tuple[int, int], Any]],
                 cached: dict[str, dict[tuple[int, int], Any]]) -> None:
        self.cells = cells
        self.cached = cached
        self.memo: dict[tuple[str, int, int], Any] = {}
        self.stack: set[tuple[str, int, int]] = set()
        self.lower = {k.lower(): k for k in cells}

    def value(self, sheet: str, r: int, c: int) -> Any:
        """Value of a cell; ``None`` when it cannot be evaluated (even if the chain is too deep)."""
        v = self.try_value(sheet, r, c)
        if v is DEFERRED:
            self.memo[(sheet, r, c)] = None
            return None
        return v

    def try_value(self, sheet: str, r: int, c: int) -> Any:
        """Like :meth:`value` but returns ``DEFERRED`` (memoising nothing on the way) when the
        dependency chain exceeds Python's recursion limit, so the caller can retry once the
        chain's earlier cells are memoised."""
        top = not self.stack
        try:
            return self._value(sheet, r, c)
        except _TooDeep:
            if not top:
                raise
            return DEFERRED

    def _value(self, sheet: str, r: int, c: int) -> Any:
        key = (sheet, r, c)
        if key in self.memo:
            return self.memo[key]
        cached = self.cached.get(sheet, {}).get((r, c))
        if cached is not None:
            return cached
        raw = self.cells.get(sheet, {}).get((r, c))
        if isinstance(raw, str) and raw.startswith("="):
            if key in self.stack:
                raise FormulaError("circular")
            self.stack.add(key)
            try:
                v = self.eval(raw[1:], sheet)
            except RecursionError:
                raise _TooDeep() from None
            except (FormulaError, ZeroDivisionError, OverflowError, ValueError, TypeError, IndexError):
                v = None
            finally:
                self.stack.discard(key)
            self.memo[key] = v
            return v
        return raw

    def eval(self, src: str, sheet: str) -> Any:
        toks = _tokenise(src)
        p = _Parser(toks, self, sheet)
        v = p.expr()
        if p.i != len(toks):
            raise FormulaError("trailing tokens")
        if isinstance(v, _Range):
            vals = v.values()
            v = vals[0] if len(vals) == 1 else None
        if isinstance(v, float) and v.is_integer() and abs(v) < 1e15:
            return int(v)
        return v

    def resolve_sheet(self, name: str | None, current: str) -> str:
        if not name:
            return current
        if name.startswith("'"):
            name = name[1:-1].replace("''", "'")
        s = self.lower.get(name.lower())
        if s is None:
            raise FormulaError("#REF!")
        return s


class _Parser:
    def __init__(self, toks, ev: Evaluator, sheet: str) -> None:
        self.toks, self.ev, self.sheet, self.i = toks, ev, sheet, 0

    def peek(self) -> tuple[str, str] | None:
        return self.toks[self.i] if self.i < len(self.toks) else None

    def take(self) -> tuple[str, str]:
        t = self.toks[self.i]
        self.i += 1
        return t

    def expect(self, val: str) -> None:
        t = self.peek()
        if not t or t[1] != val:
            raise FormulaError(f"expected {val}")
        self.i += 1

    # precedence: comparison < & < +- < */ < ^ < unary < percent
    def expr(self):
        left = self.concat()
        while (t := self.peek()) and t[0] == "op" and t[1] in ("=", "<>", "<", ">", "<=", ">="):
            self.take()
            right = self.concat()
            left, right = self._scalar(left), self._scalar(right)
            if isinstance(left, str) or isinstance(right, str):
                a, b = str(left or "").lower(), str(right or "").lower()
            else:
                a, b = _num(left), _num(right)
            left = {"=": a == b, "<>": a != b, "<": a < b, ">": a > b, "<=": a <= b, ">=": a >= b}[t[1]]
        return left

    def concat(self):
        left = self.additive()
        while (t := self.peek()) and t == ("op", "&"):
            self.take()
            right = self.additive()
            left = _text(self._scalar(left)) + _text(self._scalar(right))
        return left

    def additive(self):
        left = self.term()
        while (t := self.peek()) and t[0] == "op" and t[1] in ("+", "-"):
            self.take()
            right = self.term()
            a, b = _num(self._scalar(left)), _num(self._scalar(right))
            left = a + b if t[1] == "+" else a - b
        return left

    def term(self):
        left = self.power()
        while (t := self.peek()) and t[0] == "op" and t[1] in ("*", "/"):
            self.take()
            right = self.power()
            a, b = _num(self._scalar(left)), _num(self._scalar(right))
            if t[1] == "/" and b == 0:
                raise FormulaError("#DIV/0!")
            left = a * b if t[1] == "*" else a / b
        return left

    def power(self):
        left = self.unary()
        while (t := self.peek()) and t == ("op", "^"):
            self.take()
            right = self.unary()
            left = _num(self._scalar(left)) ** _num(self._scalar(right))
        return left

    def unary(self):
        t = self.peek()
        if t and t[0] == "op" and t[1] in ("-", "+"):
            self.take()
            v = _num(self._scalar(self.unary()))
            return -v if t[1] == "-" else v
        v = self.postfix()
        return v

    def postfix(self):
        v = self.atom()
        while (t := self.peek()) and t == ("op", "%"):
            self.take()
            v = _num(self._scalar(v)) / 100.0
        return v

    def atom(self):
        t = self.peek()
        if t is None:
            raise FormulaError("unexpected end")
        kind, val = self.take()
        if kind == "num":
            return float(val)
        if kind == "str":
            return val[1:-1].replace('""', '"')
        if kind == "bool":
            return val.upper() == "TRUE"
        if kind == "ref":
            return self._ref(val)
        if kind == "func":
            name = val[:-1].strip().upper()
            if name.startswith("_XLFN."):
                name = name[6:]
            args: list[Any] = []
            if self.peek() != ("op", ")"):
                while True:
                    if name == "IFERROR" and not args:
                        start = self.i
                        try:
                            args.append(self._scalar(self.expr()))
                        except (FormulaError, ZeroDivisionError, OverflowError, ValueError, TypeError):
                            self.i = start
                            self._skip_arg()
                            args.append(_ERR)
                    else:
                        args.append(self.expr())
                    t2 = self.peek()
                    if t2 and t2[0] == "op" and t2[1] in (",", ";"):
                        self.take()
                        continue
                    break
            self.expect(")")
            if name == "IFERROR":
                if args[0] is _ERR:
                    return self._scalar(args[1]) if len(args) > 1 else 0.0
                return args[0]
            fn = _FUNCS.get(name)
            if fn is None:
                raise FormulaError(f"unsupported {name}")
            if name in ("IF",):
                return fn([self._scalar(a) for a in args])
            if name not in ("SUM", "MIN", "MAX", "AVERAGE", "COUNT", "COUNTA", "PRODUCT", "SUMPRODUCT"):
                args = [self._scalar(a) for a in args]
            return fn(args)
        if kind == "op" and val == "(":
            v = self.expr()
            self.expect(")")
            return v
        raise FormulaError(f"unexpected {val}")

    def _ref(self, text: str):
        sheet_name = None
        if "!" in text:
            sheet_name, text = text.rsplit("!", 1)
        sheet = self.ev.resolve_sheet(sheet_name, self.sheet)
        parts = text.split(":")
        m1 = _CELL_RE.fullmatch(parts[0])
        if not m1:
            raise FormulaError("#REF!")
        c1, r1 = column_index_from_string(m1.group(1).upper()), int(m1.group(2))
        if len(parts) == 1:
            return _Range(self.ev, sheet, r1, c1, r1, c1)
        m2 = _CELL_RE.fullmatch(parts[1])
        if not m2:
            raise FormulaError("#REF!")
        c2, r2 = column_index_from_string(m2.group(1).upper()), int(m2.group(2))
        return _Range(self.ev, sheet, r1, c1, r2, c2)

    def _skip_arg(self) -> None:
        depth = 0
        while self.i < len(self.toks):
            kind, val = self.toks[self.i]
            if kind == "func" or (kind == "op" and val == "("):
                depth += 1
            elif kind == "op" and val == ")":
                if depth == 0:
                    return
                depth -= 1
            elif kind == "op" and val in (",", ";") and depth == 0:
                return
            self.i += 1

    def _scalar(self, v):
        if isinstance(v, _Range):
            if v.r1 == v.r2 and v.c1 == v.c2:
                return self.ev._value(v.sheet, v.r1, v.c1)
            raise FormulaError("#VALUE!")
        return v


_ERR = object()  # IFERROR sentinel: errors surface as exceptions while evaluating


def _text(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)
