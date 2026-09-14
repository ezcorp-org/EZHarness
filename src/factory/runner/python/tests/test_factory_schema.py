"""Behaviour tests for the generated-schema walker."""

from __future__ import annotations

import unittest
from typing import Any, ClassVar

from factory_schema import (
    matches_generated_schema,
    matches_schema,
    resolve_reference,
    type_matches,
)
from tests import REQUEST_SCHEMA, request

Json = Any


def walk(schema: dict[str, Json], value: Json) -> bool:
    return matches_schema(schema, schema, value)


class TypeMatchTest(unittest.TestCase):
    def test_every_supported_type_matches_exactly_its_own_values(self) -> None:
        self.assertTrue(type_matches("null", None))
        self.assertFalse(type_matches("null", 0))
        self.assertTrue(type_matches("array", []))
        self.assertFalse(type_matches("array", {}))
        self.assertTrue(type_matches("object", {}))
        self.assertFalse(type_matches("object", []))
        self.assertTrue(type_matches("string", "a"))
        self.assertFalse(type_matches("string", 1))
        self.assertTrue(type_matches("boolean", True))
        self.assertFalse(type_matches("boolean", 1))
        self.assertTrue(type_matches("number", 1.5))
        self.assertFalse(type_matches("number", True))

    def test_integer_means_a_safe_integer_whether_it_parsed_as_int_or_float(self) -> None:
        self.assertTrue(type_matches("integer", 3))
        self.assertTrue(type_matches("integer", 3.0))
        self.assertFalse(type_matches("integer", 3.5))
        self.assertFalse(type_matches("integer", 2**53))

    def test_a_type_the_generator_never_emits_matches_nothing(self) -> None:
        self.assertFalse(type_matches("any", "a"))


class ReferenceTest(unittest.TestCase):
    root: ClassVar[dict[str, Json]] = {"definitions": {"Named": {"type": "string"}, "NotAnObject": 7}}

    def test_a_definitions_reference_resolves_and_is_then_applied(self) -> None:
        self.assertEqual(resolve_reference(self.root, "#/definitions/Named"), {"type": "string"})
        self.assertTrue(walk({"$ref": "#/definitions/Named", **self.root}, "text"))
        self.assertFalse(walk({"$ref": "#/definitions/Named", **self.root}, 7))

    def test_a_percent_escaped_definition_name_resolves(self) -> None:
        root: dict[str, Json] = {"definitions": {"a b": {"type": "string"}}}
        self.assertEqual(resolve_reference(root, "#/definitions/a%20b"), {"type": "string"})
        self.assertIsNone(resolve_reference(root, "#/definitions/a%2zb"))

    def test_a_reference_that_cannot_resolve_matches_nothing(self) -> None:
        self.assertIsNone(resolve_reference(self.root, "http://elsewhere"))
        self.assertIsNone(resolve_reference(self.root, "#/definitions/Missing"))
        self.assertIsNone(resolve_reference(self.root, "#/definitions/NotAnObject"))
        self.assertIsNone(resolve_reference({}, "#/definitions/Named"))
        self.assertFalse(walk({"$ref": "#/definitions/Missing"}, "text"))


class KeywordTest(unittest.TestCase):
    def test_any_of_requires_one_matching_branch(self) -> None:
        schema: dict[str, Json] = {"anyOf": [{"type": "string"}, {"type": "integer"}]}
        self.assertTrue(walk(schema, "a"))
        self.assertTrue(walk(schema, 1))
        self.assertFalse(walk(schema, 1.5))
        self.assertFalse(walk({"anyOf": [7]}, 7))

    def test_a_type_union_accepts_any_listed_member(self) -> None:
        self.assertTrue(walk({"type": ["string", "null"]}, None))
        self.assertFalse(walk({"type": ["string", "null"]}, 1))
        self.assertFalse(walk({"type": [7]}, 7))

    def test_const_and_enum_compare_canonically(self) -> None:
        self.assertTrue(walk({"const": {"a": 1}}, {"a": 1.0}))
        self.assertFalse(walk({"const": {"a": 1}}, {"a": 2}))
        self.assertTrue(walk({"enum": ["a", "b"]}, "b"))
        self.assertFalse(walk({"enum": ["a", "b"]}, "c"))

    def test_array_bounds_and_item_schema_are_applied(self) -> None:
        schema: dict[str, Json] = {"type": "array", "minItems": 1, "maxItems": 2, "items": {"type": "string"}}
        self.assertTrue(walk(schema, ["a"]))
        self.assertFalse(walk(schema, []))
        self.assertFalse(walk(schema, ["a", "b", "c"]))
        self.assertFalse(walk(schema, [1]))
        self.assertTrue(walk({"type": "array", "items": 7}, [1]))

    def test_string_bounds_count_code_points(self) -> None:
        schema: dict[str, Json] = {"type": "string", "minLength": 1, "maxLength": 2}
        self.assertTrue(walk(schema, "😀😀"))
        self.assertFalse(walk(schema, ""))
        self.assertFalse(walk(schema, "abc"))

    def test_number_bounds_and_the_safe_integer_rule_are_applied(self) -> None:
        schema: dict[str, Json] = {"type": "number", "minimum": 0, "maximum": 10}
        self.assertTrue(walk(schema, 5))
        self.assertFalse(walk(schema, -1))
        self.assertFalse(walk(schema, 11))
        self.assertFalse(walk({"type": "number"}, 2**53))
        self.assertFalse(walk({"type": "number"}, float("inf")))

    def test_required_properties_and_additional_properties_are_applied(self) -> None:
        schema: dict[str, Json] = {
            "type": "object",
            "required": ["a"],
            "properties": {"a": {"type": "string"}},
            "additionalProperties": False,
        }
        self.assertTrue(walk(schema, {"a": "x"}))
        self.assertFalse(walk(schema, {}))
        self.assertFalse(walk(schema, {"a": 1}))
        self.assertFalse(walk(schema, {"a": "x", "b": 1}))
        self.assertFalse(walk({"type": "object", "required": [7]}, {}))
        self.assertFalse(walk({"type": "object", "properties": {"a": 7}}, {"a": 1}))

    def test_an_additional_properties_schema_is_applied_to_unnamed_keys(self) -> None:
        schema: dict[str, Json] = {"type": "object", "additionalProperties": {"type": "string"}}
        self.assertTrue(walk(schema, {"any": "x"}))
        self.assertFalse(walk(schema, {"any": 1}))

    def test_a_record_without_a_properties_object_still_walks_its_keys(self) -> None:
        self.assertTrue(walk({"type": "object", "properties": 7}, {"a": 1}))


class GeneratedSchemaTest(unittest.TestCase):
    def test_the_committed_request_schema_admits_the_canonical_request(self) -> None:
        self.assertTrue(matches_generated_schema(REQUEST_SCHEMA, request()))

    def test_a_value_that_is_not_i_json_is_refused_before_the_schema_runs(self) -> None:
        self.assertFalse(matches_generated_schema(REQUEST_SCHEMA, {"a": float("inf")}))


if __name__ == "__main__":
    unittest.main()
