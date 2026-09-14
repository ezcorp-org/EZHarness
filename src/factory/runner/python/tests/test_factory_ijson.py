"""Behaviour tests for the I-JSON rules and canonical encoding."""

from __future__ import annotations

import unittest

from factory_ijson import (
    MAX_SAFE_INTEGER,
    Issue,
    Result,
    canonicalize_json,
    encode_number,
    encode_string,
    encoded_bytes,
    has_unpaired_surrogate,
    is_array,
    is_bool,
    is_finite,
    is_integer_number,
    is_number,
    is_record,
    is_safe_integer,
    is_unsigned_decimal,
    json_equal,
    reject,
    unicode_length,
    validate_ijson,
)


class TypePredicateTest(unittest.TestCase):
    def test_a_boolean_is_never_a_number_although_python_makes_it_an_int(self) -> None:
        self.assertTrue(is_bool(True))
        self.assertFalse(is_number(True))
        self.assertFalse(is_integer_number(False))
        self.assertFalse(is_safe_integer(True))
        self.assertFalse(is_finite(True))

    def test_an_integral_float_is_the_same_value_as_its_integer(self) -> None:
        self.assertTrue(is_integer_number(5.0))
        self.assertTrue(is_safe_integer(5.0))
        self.assertFalse(is_integer_number(5.5))
        self.assertFalse(is_safe_integer(5.5))

    def test_the_safe_integer_boundary_matches_the_double_exact_range(self) -> None:
        self.assertTrue(is_safe_integer(MAX_SAFE_INTEGER))
        self.assertFalse(is_safe_integer(MAX_SAFE_INTEGER + 1))
        self.assertTrue(is_safe_integer(-MAX_SAFE_INTEGER))
        self.assertFalse(is_safe_integer(-MAX_SAFE_INTEGER - 1))

    def test_non_finite_numbers_are_numbers_but_not_finite(self) -> None:
        self.assertTrue(is_number(float("inf")))
        self.assertFalse(is_finite(float("inf")))
        self.assertFalse(is_finite(float("nan")))
        self.assertFalse(is_integer_number(float("nan")))
        self.assertFalse(is_finite("7"))

    def test_records_and_arrays_are_distinguished(self) -> None:
        self.assertTrue(is_record({}))
        self.assertFalse(is_record([]))
        self.assertTrue(is_array([]))
        self.assertFalse(is_array({}))


class SurrogateTest(unittest.TestCase):
    def test_a_paired_surrogate_is_accepted_and_counted_as_one_code_point(self) -> None:
        self.assertFalse(has_unpaired_surrogate("\U0001f600"))
        self.assertEqual(unicode_length("\U0001f600"), 1)
        # A well-formed pair kept as two code points, which is how the same
        # value reaches the Bun walk as UTF-16 units.
        self.assertFalse(has_unpaired_surrogate(chr(0xD83D) + chr(0xDE00)))
        self.assertFalse(has_unpaired_surrogate(chr(0xD83D) + chr(0xDE00) + "tail"))

    def test_every_lone_surrogate_shape_is_rejected(self) -> None:
        self.assertTrue(has_unpaired_surrogate("\ud800"))
        self.assertTrue(has_unpaired_surrogate("\udc00"))
        self.assertTrue(has_unpaired_surrogate("\ud800a"))
        self.assertFalse(has_unpaired_surrogate("plain"))


class UnsignedDecimalTest(unittest.TestCase):
    def test_only_a_canonical_unsigned_decimal_is_accepted(self) -> None:
        self.assertTrue(is_unsigned_decimal("0"))
        self.assertTrue(is_unsigned_decimal("1200"))
        self.assertFalse(is_unsigned_decimal(""))
        self.assertFalse(is_unsigned_decimal("01"))
        self.assertFalse(is_unsigned_decimal("-1"))
        self.assertFalse(is_unsigned_decimal("1.5"))


class ValidateIJsonTest(unittest.TestCase):
    def code(self, value: object) -> str | None:
        issue = validate_ijson(value).issue
        return issue.code if issue else None

    def test_the_ordinary_json_types_are_accepted(self) -> None:
        values: tuple[object, ...] = (None, True, "text", 1, 1.5, [], {}, {"a": [1, {"b": None}]})
        for value in values:
            self.assertIsNone(self.code(value), value)

    def test_a_non_finite_number_is_rejected(self) -> None:
        self.assertEqual(self.code(float("inf")), "IJSON_NONFINITE")
        self.assertEqual(self.code(float("nan")), "IJSON_NONFINITE")

    def test_an_unsafe_integer_is_rejected(self) -> None:
        self.assertEqual(self.code(MAX_SAFE_INTEGER + 1), "IJSON_UNSAFE_INTEGER")

    def test_an_unpaired_surrogate_is_rejected_in_a_value_and_in_a_key(self) -> None:
        self.assertEqual(self.code("\ud800"), "IJSON_SURROGATE")
        result = validate_ijson({"\ud800": 1})
        self.assertEqual(result.issue.code if result.issue else None, "IJSON_SURROGATE")
        self.assertEqual(result.issue.path if result.issue else (), ("\ud800",))

    def test_a_value_that_is_not_json_at_all_is_rejected(self) -> None:
        self.assertEqual(self.code(object()), "IJSON_TYPE")
        self.assertEqual(self.code({1: "integer key"}), "IJSON_OBJECT")

    def test_a_cycle_is_rejected_rather_than_recursed(self) -> None:
        cyclic: list[object] = []
        cyclic.append(cyclic)
        self.assertEqual(self.code(cyclic), "IJSON_CYCLE")
        record: dict[str, object] = {}
        record["self"] = record
        self.assertEqual(self.code(record), "IJSON_CYCLE")

    def test_nesting_beyond_the_limit_is_rejected(self) -> None:
        deep: object = 1
        for _ in range(64):
            deep = [deep]
        self.assertEqual(self.code(deep), "IJSON_DEPTH")

    def test_a_rejection_inside_an_array_or_record_carries_its_path(self) -> None:
        array = validate_ijson([1, float("inf")])
        self.assertEqual(array.issue.path if array.issue else (), (1,))
        record = validate_ijson({"outer": {"inner": float("inf")}})
        self.assertEqual(record.issue.path if record.issue else (), ("outer", "inner"))


class ResultShapeTest(unittest.TestCase):
    def test_an_accepted_result_reports_ok_and_carries_no_issue(self) -> None:
        accepted = Result()
        self.assertTrue(accepted.ok)
        self.assertEqual(accepted.as_json(), {"ok": True})
        self.assertEqual(repr(accepted), "Result(ok=True)")

    def test_a_rejection_reports_its_code_message_and_path(self) -> None:
        rejected = reject("CODE", "message", ("a", 1))
        self.assertFalse(rejected.ok)
        self.assertEqual(
            rejected.as_json(), {"ok": False, "issues": [{"code": "CODE", "message": "message", "path": ["a", 1]}]}
        )
        self.assertIn("CODE", repr(rejected))

    def test_two_issues_compare_by_code_message_and_path(self) -> None:
        self.assertEqual(Issue("C", "m", ("a",)), Issue("C", "m", ("a",)))
        self.assertNotEqual(Issue("C", "m", ("a",)), Issue("C", "m", ("b",)))
        self.assertNotEqual(Issue("C", "m", ()), "C")
        self.assertIn("path=['a']", repr(Issue("C", "m", ("a",))))


class JsonEqualTest(unittest.TestCase):
    def test_scalars_compare_by_value_with_booleans_kept_apart_from_numbers(self) -> None:
        self.assertTrue(json_equal(1, 1.0))
        self.assertFalse(json_equal(1, True))
        self.assertFalse(json_equal(True, 1))
        self.assertTrue(json_equal(True, True))
        self.assertFalse(json_equal(True, False))
        self.assertTrue(json_equal(None, None))
        self.assertFalse(json_equal(None, 0))
        self.assertTrue(json_equal("a", "a"))
        self.assertFalse(json_equal("a", 1))
        self.assertFalse(json_equal(1, "a"))

    def test_arrays_compare_by_length_and_position(self) -> None:
        self.assertTrue(json_equal([1, [2]], [1.0, [2]]))
        self.assertFalse(json_equal([1], [1, 2]))
        self.assertFalse(json_equal([1], {"0": 1}))

    def test_records_compare_by_key_set_and_value_regardless_of_order(self) -> None:
        self.assertTrue(json_equal({"a": 1, "b": 2}, {"b": 2, "a": 1}))
        self.assertFalse(json_equal({"a": 1}, {"a": 1, "b": 2}))
        self.assertFalse(json_equal({"a": 1}, {"b": 1}))
        self.assertFalse(json_equal({"a": 1}, 1))


class EncodingTest(unittest.TestCase):
    def test_a_string_escapes_exactly_what_json_stringify_escapes(self) -> None:
        self.assertEqual(encode_string('a"b\\c'), '"a\\"b\\\\c"')
        self.assertEqual(encode_string("\b\f\n\r\t"), '"\\b\\f\\n\\r\\t"')
        self.assertEqual(encode_string("\x01"), '"\\u0001"')
        self.assertEqual(encode_string("é"), '"é"')

    def test_an_integral_number_never_prints_a_fraction(self) -> None:
        self.assertEqual(encode_number(1), "1")
        self.assertEqual(encode_number(1.0), "1")
        self.assertEqual(encode_number(-0.0), "0")
        self.assertEqual(encode_number(1.5), "1.5")

    def test_the_decimal_and_exponential_switch_is_the_ecmascript_one(self) -> None:
        # Python's own repr switches at different points and pads the exponent,
        # so each of these would otherwise measure a different byte count.
        self.assertEqual(encode_number(0.000001), "0.000001")
        self.assertEqual(encode_number(1e-7), "1e-7")
        self.assertEqual(encode_number(1.5e-9), "1.5e-9")
        self.assertEqual(encode_number(5e-324), "5e-324")
        self.assertEqual(encode_number(1e20), "100000000000000000000")
        self.assertEqual(encode_number(1.5e21), "1.5e+21")
        self.assertEqual(encode_number(1e21), "1e+21")
        self.assertEqual(encode_number(1e300), "1e+300")
        self.assertEqual(encode_number(-1.5e-9), "-1.5e-9")
        self.assertEqual(encode_number(0.3333333333333333), "0.3333333333333333")
        self.assertEqual(encode_number(123456.789), "123456.789")

    def test_canonical_json_sorts_keys_and_keeps_array_order(self) -> None:
        self.assertEqual(canonicalize_json({"b": 1, "a": [2, 1]}), '{"a":[2,1],"b":1}')
        self.assertEqual(canonicalize_json([None, True, False]), "[null,true,false]")

    def test_canonical_json_refuses_a_value_that_is_not_i_json(self) -> None:
        with self.assertRaises(TypeError):
            canonicalize_json(float("inf"))

    def test_encoded_bytes_measures_the_canonical_utf8_encoding(self) -> None:
        self.assertEqual(encoded_bytes({"a": 1}), len('{"a":1}'))
        self.assertEqual(encoded_bytes("é"), 4)


if __name__ == "__main__":
    unittest.main()
