"""Tiny Excel formula parser/evaluator for the simple formulas found in estimates.

Supports numbers, cell refs (A1, $A$1, Sheet!A1, 'My sheet'!A1), ranges, + - * / ^ %, unary minus,
parentheses and SUM / SUMPRODUCT(simple) / MIN / MAX / AVERAGE / ROUND / ROUNDUP / ROUNDDOWN / ABS / IF(cond).
Used (1) to compute values of formula cells that have no cached value (files written by tools that never
calculate) and (2) to recognise calculation logic (`=G12*D12`, `=SUM(J5:J40)`, `=J41*0.2`).
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Callable

from openpyxl.utils.cell import column_index_from_string

_TOKEN = re.compile(r"""
    (?P<ws>\s+)
  | (?P<str>"(?:[^"]|"")*")
  | (?P<ref>(?:(?:'(?:[^']|'')+'|[A-Za-z_][\w.]*)!)?\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?)
  | (?P<num>\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+)
  | (?P<func>[A-Za-z_][A-Za-z0-9_.]*\s*\()
  | (?P<op><>|<=|>=|[-+*/^%&=<>(),;:])
  | (?P<name>[A-Za-z_][\w.]*)
""", re.VERBOSE)

_REF = re.compile(r"^(?:(?P<sheet>'(?:[^']|'')+'|[^!]+)!)?\$?(?P<c1>[A-Za-z]{1,3})\$?(?P<r1>\d+)"
                  r"(?::\$?(?P<c2>[A-Za-z]{1,3})\$?(?P<r2>\d+))?$")


class FormulaError(ValueError):
    pass


@dataclass
class Parsed:
    text: str
    ast: Any
    refs: list[tuple[str | None, int, int]] = field(default_factory=list)          # (sheet, col, row)
    ranges: list[tuple[str | None, int, int, int, int]] = field(default_factory=list)  # (sheet,c1,r1,c2,r2)
    funcs: list[str] = field(default_factory=list)


def _tokenise(s: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    pos = 0
    while pos < len(s):
        m = _TOKEN.match(s, pos)
        if not m:
            raise FormulaError(f"bad token at {pos}: {s[pos:pos + 10]!r}")
        pos = m.end()
        kind = m.lastgroup
        if kind == "ws":
            continue
        out.append((kind, m.group(kind)))
    return out


class _Parser:
    def __init__(self, toks: list[tuple[str, str]], p: Parsed):
        self.t = toks
        self.i = 0
        self.p = p

    def peek(self) -> tuple[str, str] | None:
        return self.t[self.i] if self.i < len(self.t) else None

    def take(self) -> tuple[str, str]:
        tok = self.peek()
        if tok is None:
            raise FormulaError("unexpected end")
        self.i += 1
        return tok

    def expect(self, val: str) -> None:
        tok = self.take()
        if tok[1] != val:
            raise FormulaError(f"expected {val}, got {tok[1]}")

    def parse(self):
        node = self.comparison()
        if self.peek() is not None:
            raise FormulaError(f"trailing tokens: {self.t[self.i:]}")
        return node

    def comparison(self):
        node = self.concat()
        while (tok := self.peek()) and tok[0] == "op" and tok[1] in ("=", "<>", "<", ">", "<=", ">="):
            self.take()
            node = ("bin", tok[1], node, self.concat())
        return node

    def concat(self):
        node = self.additive()
        while (tok := self.peek()) and tok[1] == "&":
            self.take()
            node = ("bin", "&", node, self.additive())
        return node

    def additive(self):
        node = self.term()
        while (tok := self.peek()) and tok[0] == "op" and tok[1] in "+-":
            self.take()
            node = ("bin", tok[1], node, self.term())
        return node

    def term(self):
        node = self.power()
        while (tok := self.peek()) and tok[0] == "op" and tok[1] in "*/":
            self.take()
            node = ("bin", tok[1], node, self.power())
        return node

    def power(self):
        node = self.unary()
        while (tok := self.peek()) and tok[1] == "^":
            self.take()
            node = ("bin", "^", node, self.unary())
        return node

    def unary(self):
        tok = self.peek()
        if tok and tok[0] == "op" and tok[1] in "+-":
            self.take()
            inner = self.unary()
            return ("neg", inner) if tok[1] == "-" else inner
        node = self.primary()
        while (tok := self.peek()) and tok[1] == "%":
            self.take()
            node = ("pct", node)
        return node

    def primary(self):
        kind, val = self.take()
        if kind == "num":
            return ("num", float(val))
        if kind == "str":
            return ("str", val[1:-1].replace('""', '"'))
        if kind == "ref":
            m = _REF.match(val)
            if not m:
                raise FormulaError(val)
            sheet = m.group("sheet")
            if sheet:
                sheet = sheet.strip("'").replace("''", "'")
            c1 = column_index_from_string(m.group("c1").upper())
            r1 = int(m.group("r1"))
            if m.group("c2"):
                c2 = column_index_from_string(m.group("c2").upper())
                r2 = int(m.group("r2"))
                c1, c2 = min(c1, c2), max(c1, c2)
                r1, r2 = min(r1, r2), max(r1, r2)
                self.p.ranges.append((sheet, c1, r1, c2, r2))
                return ("range", sheet, c1, r1, c2, r2)
            self.p.refs.append((sheet, c1, r1))
            return ("ref", sheet, c1, r1)
        if kind == "func":
            name = val[:-1].strip().upper().removeprefix("_XLFN.")
            self.p.funcs.append(name)
            args = []
            if self.peek() and self.peek()[1] == ")":
                self.take()
                return ("func", name, args)
            while True:
                args.append(self.comparison())
                tok = self.take()
                if tok[1] == ")":
                    break
                if tok[1] not in (",", ";"):
                    raise FormulaError(f"bad arg separator {tok[1]}")
            return ("func", name, args)
        if kind == "op" and val == "(":
            node = self.comparison()
            self.expect(")")
            return node
        if kind == "name":
            up = val.upper()
            if up in ("TRUE", "FALSE"):
                return ("num", 1.0 if up == "TRUE" else 0.0)
            return ("name", val)
        raise FormulaError(f"unexpected {val}")


@lru_cache(maxsize=32768)
def parse_formula(formula: str) -> Parsed | None:
    """Parse `=...` (leading '=' optional). Returns None for anything we can't parse."""
    if not isinstance(formula, str):
        return None
    text = formula.strip()
    if text.startswith("="):
        text = text[1:]
    if not text:
        return None
    p = Parsed(text=text, ast=None)
    try:
        p.ast = _Parser(_tokenise(text), p).parse()
    except (FormulaError, ValueError, IndexError):
        return None
    return p


Getter = Callable[[str | None, int, int], Any]


def _num(v: Any) -> float | None:
    if v is None or isinstance(v, bool):
        return None if v is None else float(v)
    if isinstance(v, (int, float)):
        return float(v)
    return None


def _round(x: float, n: int, mode: str) -> float:
    f = 10 ** n
    if mode == "up":
        return math.copysign(math.ceil(abs(x) * f - 1e-9) / f, x)
    if mode == "down":
        return math.copysign(math.floor(abs(x) * f + 1e-9) / f, x)
    return math.copysign(math.floor(abs(x) * f + 0.5) / f, x)


def evaluate(parsed: Parsed | str | None, get: Getter) -> float | None:
    """Evaluate with `get(sheet, col, row)` returning a cell's value. None when not computable."""
    if isinstance(parsed, str):
        parsed = parse_formula(parsed)
    if parsed is None:
        return None
    try:
        v = _eval(parsed.ast, get)
    except (FormulaError, ZeroDivisionError, OverflowError, TypeError, ValueError, RecursionError):
        return None
    if isinstance(v, list):
        v = sum(x for x in v if x is not None)
    return v if isinstance(v, float) and math.isfinite(v) else None


def _values(node, get: Getter) -> list[float]:
    if node[0] == "range":
        _, sh, c1, r1, c2, r2 = node
        if (c2 - c1 + 1) * (r2 - r1 + 1) > 200_000:
            raise FormulaError("range too large")
        out = []
        for r in range(r1, r2 + 1):
            for c in range(c1, c2 + 1):
                x = _num(get(sh, c, r))
                if x is not None:
                    out.append(x)
        return out
    v = _eval(node, get)
    if isinstance(v, list):
        return v
    return [] if v is None else [v]


def _eval(node, get: Getter):
    kind = node[0]
    if kind == "num":
        return node[1]
    if kind == "str":
        raise FormulaError("string")
    if kind == "ref":
        v = get(node[1], node[2], node[3])
        if v is None or v == "":
            return 0.0
        n = _num(v)
        if n is None and isinstance(v, str):
            from .util import parse_number   # numbers stored as text ("6,80")
            n = parse_number(v)
        if n is None:
            raise FormulaError("non-numeric ref")
        return n
    if kind == "range":
        return _values(node, get)
    if kind == "neg":
        return -_scalar(_eval(node[1], get))
    if kind == "pct":
        return _scalar(_eval(node[1], get)) / 100.0
    if kind == "bin":
        op = node[1]
        a = _scalar(_eval(node[2], get))
        b = _scalar(_eval(node[3], get))
        if op == "+":
            return a + b
        if op == "-":
            return a - b
        if op == "*":
            return a * b
        if op == "/":
            return a / b
        if op == "^":
            return a ** b
        if op == "=":
            return float(a == b)
        if op == "<>":
            return float(a != b)
        if op == "<":
            return float(a < b)
        if op == ">":
            return float(a > b)
        if op == "<=":
            return float(a <= b)
        if op == ">=":
            return float(a >= b)
        raise FormulaError(op)
    if kind == "func":
        name, args = node[1], node[2]
        if name == "SUM":
            return sum(x for a in args for x in _values(a, get))
        if name in ("MIN", "MAX"):
            vals = [x for a in args for x in _values(a, get)]
            return (min if name == "MIN" else max)(vals) if vals else 0.0
        if name == "AVERAGE":
            vals = [x for a in args for x in _values(a, get)]
            return sum(vals) / len(vals) if vals else 0.0
        if name in ("ROUND", "ROUNDUP", "ROUNDDOWN"):
            x = _scalar(_eval(args[0], get))
            n = int(_scalar(_eval(args[1], get))) if len(args) > 1 else 0
            return _round(x, n, {"ROUND": "half", "ROUNDUP": "up", "ROUNDDOWN": "down"}[name])
        if name == "ABS":
            return abs(_scalar(_eval(args[0], get)))
        if name == "IF":
            cond = _scalar(_eval(args[0], get))
            branch = args[1] if cond else (args[2] if len(args) > 2 else ("num", 0.0))
            return _scalar(_eval(branch, get))
        if name == "SUMPRODUCT" and len(args) == 2 and args[0][0] == "range" and args[1][0] == "range":
            a = _cells(args[0], get)
            b = _cells(args[1], get)
            if len(a) != len(b):
                raise FormulaError("shape")
            return sum((x or 0.0) * (y or 0.0) for x, y in zip(a, b))
        raise FormulaError(f"unsupported function {name}")
    raise FormulaError(kind)


def _cells(node, get: Getter) -> list[float | None]:
    _, sh, c1, r1, c2, r2 = node
    return [_num(get(sh, c, r)) for r in range(r1, r2 + 1) for c in range(c1, c2 + 1)]


def _scalar(v) -> float:
    if isinstance(v, list):
        if len(v) == 1:
            return v[0]
        raise FormulaError("range used as scalar")
    if v is None:
        return 0.0
    return v


# ------------------------------------------------------------------ shape recognition (for logic)

def shape(parsed: Parsed | str | None) -> dict[str, Any] | None:
    """Recognise simple shapes:
    {"kind":"product","refs":[(sheet,col,row),...],"const":k}   =D12*G12 / =D12*G12*1.1
    {"kind":"sum_range","range":(sheet,c1,r1,c2,r2)}             =SUM(J5:J40)
    {"kind":"sum_refs","refs":[...]}                              =J12+K12+L12 / =SUM(J12,K12)
    {"kind":"scale","ref":(sheet,col,row),"factor":0.2}           =J41*0.2 / =J41*20% / =J41/100*20
    {"kind":"ref","ref":...}                                      =J41
    """
    if isinstance(parsed, str):
        parsed = parse_formula(parsed)
    if parsed is None:
        return None
    ast = _strip_round(parsed.ast)
    if ast[0] == "ref":
        return {"kind": "ref", "ref": ast[1:]}
    if ast[0] == "func" and ast[1] == "SUM":
        args = ast[2]
        if len(args) == 1 and args[0][0] == "range":
            return {"kind": "sum_range", "range": args[0][1:]}
        if args and all(a[0] == "ref" for a in args):
            return {"kind": "sum_refs", "refs": [a[1:] for a in args]}
        if args and all(a[0] in ("ref", "range") for a in args):
            return {"kind": "sum_mixed", "refs": [a[1:] for a in args if a[0] == "ref"],
                    "ranges": [a[1:] for a in args if a[0] == "range"]}
    factors = _flatten(ast, "*")
    if factors is not None:
        refs = [f[1:] for f in factors if f[0] == "ref"]
        consts = [f for f in factors if f[0] in ("num", "pct", "div_const")]
        if len(refs) + len(consts) == len(factors):
            k = 1.0
            for c in consts:
                k *= _const_value(c)
            if len(refs) == 1 and consts:
                return {"kind": "scale", "ref": refs[0], "factor": k}
            if len(refs) >= 2:
                return {"kind": "product", "refs": refs, "const": k}
    terms = _flatten(ast, "+")
    if terms is not None and len(terms) >= 2 and all(t[0] == "ref" for t in terms):
        return {"kind": "sum_refs", "refs": [t[1:] for t in terms]}
    return {"kind": "other"}


def _strip_round(ast):
    while ast[0] == "func" and ast[1] in ("ROUND", "ROUNDUP", "ROUNDDOWN") and ast[2]:
        ast = ast[2][0]
    return ast


def _const_value(node) -> float:
    if node[0] == "num":
        return node[1]
    if node[0] == "pct":
        return _const_value(node[1]) / 100.0
    if node[0] == "div_const":
        return 1.0 / node[1]
    raise FormulaError("not const")


def _is_const(node) -> bool:
    return node[0] == "num" or (node[0] == "pct" and _is_const(node[1]))


def _flatten(ast, op: str):
    """Flatten a chain of `op` into factors/terms. For '*', a '/const' becomes a div_const factor."""
    if ast[0] == "bin" and ast[1] == op:
        left = _flatten(ast[2], op)
        right = _flatten(ast[3], op)
        if left is None or right is None:
            return None
        return left + right
    if op == "*" and ast[0] == "bin" and ast[1] == "/" and _is_const(ast[3]):
        left = _flatten(ast[2], op)
        if left is None:
            return None
        return left + [("div_const", _const_value(ast[3]))]
    if ast[0] == "pct" and op == "*":
        return [ast]
    if ast[0] in ("ref", "num"):
        return [ast]
    if op == "*" and ast[0] == "bin" and ast[1] == "+":
        return None
    return [ast] if ast[0] in ("ref", "num") else None
