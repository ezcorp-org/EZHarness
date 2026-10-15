"""I-JSON rules and canonical encoding for the Python runtime.

This is the Python half of one contract, not a second contract.  Every rule here
is the exact counterpart of ``packages/@ezcorp/factory-sdk/src/canonical.ts``, so
a value the Bun runtime accepts is accepted here and a value it rejects is
rejected here with the same issue code.  C07 rejects a validator that works in
only one runtime, and the conformance suite compares the two verdict by verdict.

Two JavaScript facts drive the shapes below.

* Every JSON number is a double there, so ``1`` and ``1.0`` are the same value
  and both are integers.  Python keeps them apart, so ``is_integer_number``
  folds an integral float back into the JavaScript meaning.
* ``JSON.stringify`` escapes exactly the quote, the backslash and the control
  characters, and prints a float in its shortest round-trip form.  ``encode``
  reproduces that byte for byte, because the canonical encoding decides a wire
  size limit and the two runtimes must measure the same number of bytes.
"""

from __future__ import annotations

import math
from typing import Any, Final

MAX_JSON_DEPTH: Final = 64
MAX_SAFE_INTEGER: Final = 2**53 - 1

Json = Any


class Issue:
    """One rejection: the stable code, its message, and the path that carries it."""

    __slots__ = ("code", "message", "path")

    def __init__(self, code: str, message: str, path: tuple[str | int, ...] = ()) -> None:
        self.code = code
        self.message = message
        self.path = path

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Issue):
            return NotImplemented
        return (self.code, self.message, self.path) == (other.code, other.message, other.path)

    def __repr__(self) -> str:
        return f"Issue(code={self.code!r}, path={list(self.path)!r})"


class Result:
    """A verdict. ``ok`` carries no issue; a rejection carries exactly one."""

    __slots__ = ("issue",)

    def __init__(self, issue: Issue | None = None) -> None:
        self.issue = issue

    @property
    def ok(self) -> bool:
        return self.issue is None

    def as_json(self) -> dict[str, Json]:
        if self.issue is None:
            return {"ok": True}
        return {
            "ok": False,
            "issues": [{"code": self.issue.code, "message": self.issue.message, "path": list(self.issue.path)}],
        }

    def __repr__(self) -> str:
        return "Result(ok=True)" if self.issue is None else f"Result({self.issue!r})"


OK: Final = Result()


def reject(code: str, message: str, path: tuple[str | int, ...] = ()) -> Result:
    return Result(Issue(code, message, path))


def is_bool(value: Json) -> bool:
    return isinstance(value, bool)


def is_number(value: Json) -> bool:
    """A JavaScript number: every JSON numeric value, and never a boolean."""
    return isinstance(value, int | float) and not isinstance(value, bool)


def is_integer_number(value: Json) -> bool:
    """``Number.isInteger``: an integral value, whether it parsed as int or float."""
    if not is_number(value):
        return False
    if isinstance(value, int):
        return True
    return math.isfinite(value) and float(value).is_integer()


def is_safe_integer(value: Json) -> bool:
    """``Number.isSafeInteger``: integral and inside the double-exact range."""
    return is_integer_number(value) and abs(int(value)) <= MAX_SAFE_INTEGER


def is_finite(value: Json) -> bool:
    return is_number(value) and math.isfinite(float(value))


def is_record(value: Json) -> bool:
    return isinstance(value, dict)


def is_array(value: Json) -> bool:
    return isinstance(value, list)


def has_unpaired_surrogate(value: str) -> bool:
    """Python decodes a lone ``\\udXXX`` escape into a lone code point, so a
    direct scan is the exact counterpart of the UTF-16 pair walk in Bun."""
    index = 0
    length = len(value)
    while index < length:
        unit = ord(value[index])
        if 0xD800 <= unit <= 0xDBFF:
            if index + 1 >= length or not 0xDC00 <= ord(value[index + 1]) <= 0xDFFF:
                return True
            index += 2
            continue
        if 0xDC00 <= unit <= 0xDFFF:
            return True
        index += 1
    return False


def unicode_length(value: str) -> int:
    """Code points, matching the ``for...of`` walk the SDK uses."""
    return len(value)


def is_unsigned_decimal(value: str) -> bool:
    if len(value) == 0 or (len(value) > 1 and value[0] == "0"):
        return False
    return all("0" <= character <= "9" for character in value)


def _validate(value: Json, path: tuple[str | int, ...], ancestors: tuple[int, ...], depth: int) -> Result:
    if depth > MAX_JSON_DEPTH:
        return reject("IJSON_DEPTH", "I-JSON value exceeds the nesting limit.", path)
    if value is None or is_bool(value):
        return OK
    if isinstance(value, str):
        if has_unpaired_surrogate(value):
            return reject("IJSON_SURROGATE", "Strings cannot contain unpaired Unicode surrogates.", path)
        return OK
    if is_number(value):
        if not is_finite(value):
            return reject("IJSON_NONFINITE", "Numbers must be finite.", path)
        if is_integer_number(value) and not is_safe_integer(value):
            return reject("IJSON_UNSAFE_INTEGER", "Integers must be safe I-JSON integers.", path)
        return OK
    if not (is_array(value) or is_record(value)):
        return reject("IJSON_TYPE", "Value is not valid I-JSON.", path)
    if id(value) in ancestors:
        return reject("IJSON_CYCLE", "I-JSON values cannot contain cycles.", path)
    nested = (*ancestors, id(value))
    if is_array(value):
        for index, item in enumerate(value):
            result = _validate(item, (*path, index), nested, depth + 1)
            if not result.ok:
                return result
        return OK
    for key, item in value.items():
        if not isinstance(key, str):
            return reject("IJSON_OBJECT", "I-JSON objects must be plain records.", path)
        if has_unpaired_surrogate(key):
            return reject("IJSON_SURROGATE", "Object keys cannot contain unpaired Unicode surrogates.", (*path, key))
        result = _validate(item, (*path, key), nested, depth + 1)
        if not result.ok:
            return result
    return OK


def validate_ijson(value: Json) -> Result:
    return _validate(value, (), (), 1)


def json_equal(left: Json, right: Json) -> bool:
    """Structural equality over I-JSON. Numbers compare by value, as they do in
    JavaScript where ``1`` and ``1.0`` are one value."""
    if is_bool(left) or is_bool(right):
        return is_bool(left) and is_bool(right) and left is right
    if is_number(left) and is_number(right):
        return float(left) == float(right)
    if left is None or right is None:
        return left is None and right is None
    if isinstance(left, str) or isinstance(right, str):
        return isinstance(left, str) and isinstance(right, str) and left == right
    if is_array(left) or is_array(right):
        return (
            is_array(left)
            and is_array(right)
            and len(left) == len(right)
            and all(json_equal(item, right[index]) for index, item in enumerate(left))
        )
    if is_record(left) and is_record(right):
        return len(left) == len(right) and all(
            key in right and json_equal(item, right[key]) for key, item in left.items()
        )
    return False


_ESCAPES: Final = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}


def encode_string(value: str) -> str:
    """``JSON.stringify`` for a string: quote, backslash, and control characters."""
    out = ['"']
    for character in value:
        escape = _ESCAPES.get(character)
        if escape is not None:
            out.append(escape)
        elif ord(character) < 0x20:
            out.append(f"\\u{ord(character):04x}")
        else:
            out.append(character)
    out.append('"')
    return "".join(out)


def _shortest_digits(value: float) -> tuple[str, int]:
    """The shortest round-trip digits ``s`` and the decimal exponent ``n`` for
    which ``value == 0.s * 10**n``, which is the (s, k, n) triple the
    ECMAScript number-to-string algorithm is written over."""
    text = repr(abs(value))
    mantissa, separator, exponent = text.partition("e")
    power = int(exponent) if separator else 0
    whole, _, fraction = mantissa.partition(".")
    combined = whole + fraction
    stripped = combined.lstrip("0")
    leading = len(combined) - len(stripped)
    # Only a non-integral finite float reaches this, so at least one significant
    # digit always survives the strip.
    digits = stripped.rstrip("0")
    return digits, len(whole) + power - leading


def encode_number(value: float | int) -> str:
    """``JSON.stringify`` for a number.

    An integral value loses its fraction. Everything else follows the
    ECMAScript rule, which prints a decimal while the exponent stays inside
    ``(-6, 21]`` and an exponential form outside it. Python's own ``repr``
    switches at different points and pads the exponent, so a float would
    otherwise measure a different number of bytes in the two runtimes.
    """
    if is_integer_number(value) and abs(value) < 10**21:
        return str(int(value))
    number = float(value)
    sign = "-" if number < 0 else ""
    digits, point = _shortest_digits(number)
    count = len(digits)
    # A value with no digit after the point is integral and was already
    # answered above, so the decimal form always splits the digits.
    if 0 < point <= 21:
        return f"{sign}{digits[:point]}.{digits[point:]}"
    if -6 < point <= 0:
        return f"{sign}0.{'0' * -point}{digits}"
    exponent = point - 1
    mantissa = digits if count == 1 else f"{digits[0]}.{digits[1:]}"
    return f"{sign}{mantissa}e{'+' if exponent >= 0 else '-'}{abs(exponent)}"


def _serialize(value: Json) -> str:
    if value is None:
        return "null"
    if is_bool(value):
        return "true" if value else "false"
    if is_number(value):
        return encode_number(value)
    if isinstance(value, str):
        return encode_string(value)
    if is_array(value):
        return "[" + ",".join(_serialize(item) for item in value) + "]"
    keys = sorted(value.keys())
    return "{" + ",".join(f"{encode_string(key)}:{_serialize(value[key])}" for key in keys) + "}"


def canonicalize_json(value: Json) -> str:
    issue = validate_ijson(value).issue
    if issue is not None:
        raise TypeError(issue.message)
    return _serialize(value)


def encoded_bytes(value: Json) -> int:
    return len(canonicalize_json(value).encode("utf-8"))
