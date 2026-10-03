"""Behaviour tests for the C02 request and result semantics.

Each case varies exactly one field of a canonical envelope and names the issue
code the shared contract requires, so a drift in either runtime shows up as a
different code rather than as a silent acceptance.
"""

from __future__ import annotations

import unittest
from typing import Any
from unittest import mock

import factory_validation
from factory_validation import (
    bounded_text,
    is_manifest_name,
    resolve_local_reference,
    safe_counter,
    valid_digest,
    validate_factory_runner_request,
    validate_factory_runner_result,
    validate_port_schema,
)
from tests import (
    DIGEST,
    OTHER_DIGEST,
    REQUEST_SCHEMA,
    RESULT_SCHEMA,
    at,
    request,
    result,
    without,
)

Json = Any


def request_code(value: Json) -> str | None:
    issue = validate_factory_runner_request(value, REQUEST_SCHEMA).issue
    return issue.code if issue else None


def result_code(value: Json) -> str | None:
    issue = validate_factory_runner_result(value, RESULT_SCHEMA).issue
    return issue.code if issue else None


def schema_code(value: Json) -> str | None:
    issue = validate_port_schema(value).issue
    return issue.code if issue else None


class HelperTest(unittest.TestCase):
    def test_a_digest_is_sixty_four_lowercase_hexadecimal_characters(self) -> None:
        self.assertTrue(valid_digest(DIGEST, False))
        self.assertTrue(valid_digest(f"sha256:{DIGEST}", True))
        self.assertFalse(valid_digest(DIGEST, True))
        self.assertFalse(valid_digest("A" * 64, False))
        self.assertFalse(valid_digest("a" * 63, False))
        self.assertFalse(valid_digest(7, False))

    def test_a_counter_must_be_a_safe_integer_at_or_above_its_floor(self) -> None:
        self.assertTrue(safe_counter(0))
        self.assertFalse(safe_counter(-1))
        self.assertTrue(safe_counter(-1, -1))
        self.assertFalse(safe_counter(2**53))

    def test_bounded_text_refuses_empty_long_and_control_values(self) -> None:
        self.assertTrue(bounded_text("a"))
        self.assertFalse(bounded_text(""))
        self.assertFalse(bounded_text("a" * 257))
        self.assertTrue(bounded_text("a" * 257, 512))
        self.assertFalse(bounded_text("a"))
        self.assertFalse(bounded_text(7))


class PortSchemaTest(unittest.TestCase):
    def test_a_declared_object_schema_is_accepted(self) -> None:
        self.assertIsNone(schema_code({"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"]}))

    def test_the_node_itself_must_be_an_object(self) -> None:
        self.assertEqual(schema_code(7), "SCHEMA_OBJECT_REQUIRED")

    def test_an_unsupported_keyword_is_named_in_the_rejection(self) -> None:
        self.assertEqual(schema_code({"type": "string", "pattern": "^a$"}), "SCHEMA_KEYWORD_UNSUPPORTED")
        self.assertEqual(schema_code({"type": "string", "allOf": []}), "SCHEMA_KEYWORD_UNSUPPORTED")

    def test_descriptive_fields_must_still_be_strings(self) -> None:
        self.assertEqual(schema_code({"type": "string", "title": 7}), "SCHEMA_DESCRIPTION_INVALID")
        self.assertEqual(schema_code({"type": "string", "description": 7}), "SCHEMA_DESCRIPTION_INVALID")

    def test_structural_keywords_must_carry_their_declared_shape(self) -> None:
        self.assertEqual(
            schema_code({"type": "object", "additionalProperties": 1}), "SCHEMA_ADDITIONAL_PROPERTIES_INVALID"
        )
        self.assertEqual(schema_code({"type": "object", "properties": []}), "SCHEMA_PROPERTIES_INVALID")
        self.assertEqual(schema_code({"type": "object", "$defs": []}), "SCHEMA_DEFS_INVALID")
        self.assertEqual(schema_code({"type": "array", "items": []}), "SCHEMA_ITEMS_INVALID")
        self.assertEqual(schema_code({"type": "object", "required": "a"}), "SCHEMA_REQUIRED_INVALID")
        self.assertEqual(schema_code({"type": "object", "required": [7]}), "SCHEMA_REQUIRED_INVALID")

    def test_an_enum_must_be_nonempty_i_json_and_unique(self) -> None:
        self.assertEqual(schema_code({"type": "string", "enum": []}), "SCHEMA_ENUM_INVALID")
        self.assertEqual(schema_code({"type": "string", "enum": "a"}), "SCHEMA_ENUM_INVALID")
        self.assertEqual(schema_code({"type": "number", "enum": [float("inf")]}), "SCHEMA_ENUM_INVALID")
        self.assertEqual(schema_code({"type": "string", "enum": ["a", "a"]}), "SCHEMA_ENUM_INVALID")
        self.assertIsNone(schema_code({"type": "string", "enum": ["a", "b"]}))

    def test_bounds_must_be_nonnegative_safe_integers_or_finite_numbers_in_order(self) -> None:
        self.assertEqual(schema_code({"type": "array", "minItems": -1}), "SCHEMA_BOUND_INVALID")
        self.assertEqual(schema_code({"type": "array", "maxItems": 1.5}), "SCHEMA_BOUND_INVALID")
        self.assertEqual(schema_code({"type": "number", "minimum": "0"}), "SCHEMA_BOUND_INVALID")
        self.assertEqual(schema_code({"type": "number", "maximum": float("inf")}), "SCHEMA_BOUND_INVALID")
        self.assertEqual(schema_code({"type": "array", "minItems": 2, "maxItems": 1}), "SCHEMA_BOUND_ORDER")
        self.assertEqual(schema_code({"type": "string", "minLength": 2, "maxLength": 1}), "SCHEMA_BOUND_ORDER")
        self.assertEqual(schema_code({"type": "number", "minimum": 2, "maximum": 1}), "SCHEMA_BOUND_ORDER")

    def test_a_const_must_be_i_json(self) -> None:
        self.assertEqual(schema_code({"type": "number", "const": float("nan")}), "SCHEMA_CONST_INVALID")
        self.assertIsNone(schema_code({"type": "number", "const": 1}))

    def test_a_local_reference_resolves_and_refuses_execution_siblings(self) -> None:
        schema: dict[str, Json] = {"$defs": {"Named": {"type": "string"}}, "$ref": "#/$defs/Named"}
        self.assertIsNone(schema_code(schema))
        self.assertEqual(schema_code({**schema, "type": "string"}), "SCHEMA_REF_SIBLING")
        self.assertEqual(schema_code({"$ref": "#/$defs/Missing"}), "SCHEMA_REF_INVALID")
        self.assertEqual(schema_code({"$ref": 7}), "SCHEMA_REF_INVALID")
        self.assertEqual(schema_code({"$defs": {"N": {"type": "bad"}}, "$ref": "#/$defs/N"}), "SCHEMA_TYPE_UNSUPPORTED")

    def test_a_pointer_escape_is_decoded_and_a_bad_escape_resolves_to_nothing(self) -> None:
        root: dict[str, Json] = {"$defs": {"a/b": {"type": "string"}, "c~d": {"type": "string"}}}
        self.assertEqual(resolve_local_reference(root, "#/$defs/a~1b"), {"type": "string"})
        self.assertEqual(resolve_local_reference(root, "#/$defs/c~0d"), {"type": "string"})
        self.assertIsNone(resolve_local_reference(root, "#/$defs/a~2b"))
        self.assertEqual(resolve_local_reference(root, "#"), root)
        self.assertIsNone(resolve_local_reference(root, "elsewhere"))
        self.assertIsNone(resolve_local_reference(root, "#elsewhere"))
        self.assertIsNone(resolve_local_reference(root, "#/$defs/a/b"))
        self.assertIsNone(resolve_local_reference({"$defs": {"n": 7}}, "#/$defs/n"))

    def test_a_recursive_schema_is_rejected(self) -> None:
        node: dict[str, Json] = {"type": "object", "properties": {}}
        node["properties"]["self"] = node
        self.assertEqual(schema_code(node), "SCHEMA_RECURSIVE")

    def test_a_type_is_required_and_only_a_nullable_union_may_list_two(self) -> None:
        self.assertEqual(schema_code({}), "SCHEMA_TYPE_REQUIRED")
        self.assertEqual(schema_code({"type": "unknown"}), "SCHEMA_TYPE_UNSUPPORTED")
        self.assertEqual(schema_code({"type": ["string", "number"]}), "SCHEMA_TYPE_UNSUPPORTED")
        self.assertEqual(schema_code({"type": ["null", "null"]}), "SCHEMA_TYPE_UNSUPPORTED")
        self.assertEqual(schema_code({"type": ["string", "null", "number"]}), "SCHEMA_TYPE_UNSUPPORTED")
        self.assertIsNone(schema_code({"type": ["string", "null"]}))

    def test_required_names_must_be_unique_declared_properties(self) -> None:
        self.assertEqual(schema_code({"type": "object", "required": ["a"]}), "SCHEMA_REQUIRED_INVALID")
        self.assertEqual(
            schema_code({"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a", "a"]}),
            "SCHEMA_REQUIRED_INVALID",
        )

    def test_a_valid_nested_position_lets_the_walk_continue(self) -> None:
        nested: Json = {"type": "array", "items": {"type": "string"}, "$defs": {"n": {"type": "string"}}}
        self.assertIsNone(schema_code(nested))

    def test_every_nested_position_is_walked(self) -> None:
        self.assertEqual(
            schema_code({"type": "object", "properties": {"a": {"type": "bad"}}}), "SCHEMA_TYPE_UNSUPPORTED"
        )
        self.assertEqual(schema_code({"type": "array", "items": {"type": "bad"}}), "SCHEMA_TYPE_UNSUPPORTED")
        self.assertEqual(schema_code({"type": "string", "$defs": {"n": {"type": "bad"}}}), "SCHEMA_TYPE_UNSUPPORTED")


class RunnerRequestTest(unittest.TestCase):
    def test_the_canonical_request_is_accepted(self) -> None:
        self.assertIsNone(request_code(request()))

    def test_a_value_outside_the_generated_schema_is_refused_first(self) -> None:
        self.assertEqual(request_code({}), "RUNNER_REQUEST_SCHEMA")
        self.assertEqual(
            request_code(at(request(), ["schemaVersion"], "factory.runner.request.v2")), "RUNNER_REQUEST_SCHEMA"
        )
        self.assertEqual(request_code(at(request(), ["authority", "attemptId"], 7)), "RUNNER_REQUEST_SCHEMA")

    def test_an_envelope_beyond_the_wire_limit_is_refused(self) -> None:
        oversized = at(request(), ["input", "value"], {"prompt": "x" * 70_000})
        self.assertEqual(request_code(oversized), "RUNNER_WIRE_BYTES")

    def test_authority_identities_must_be_bounded_and_counters_nonnegative(self) -> None:
        self.assertEqual(request_code(at(request(), ["authority", "attemptId"], "")), "RUNNER_AUTHORITY")
        self.assertEqual(request_code(at(request(), ["authority", "attemptId"], "a" * 1_025)), "RUNNER_AUTHORITY")
        self.assertEqual(request_code(at(request(), ["authority", "attemptNumber"], -1)), "RUNNER_AUTHORITY")
        # An unsafe integer never reaches the semantics: the generated schema's
        # own safe-integer rule refuses it first, in both runtimes.
        self.assertEqual(
            request_code(at(request(), ["authority", "nextOperationIndex"], 2**53)), "RUNNER_REQUEST_SCHEMA"
        )

    def test_the_deadline_must_be_a_positive_epoch_millisecond(self) -> None:
        self.assertEqual(request_code(at(request(), ["authority", "deadlineAtMs"], 0)), "RUNNER_DEADLINE")

    def test_the_runner_pin_must_name_an_exact_version_and_digest(self) -> None:
        self.assertEqual(request_code(at(request(), ["runner", "version"], "latest")), "RUNNER_PIN")
        self.assertEqual(request_code(at(request(), ["runner", "version"], "1.*")), "RUNNER_PIN")
        self.assertEqual(request_code(at(request(), ["runner", "digest"], DIGEST)), "RUNNER_PIN")
        self.assertEqual(request_code(at(request(), ["runner", "package"], "")), "RUNNER_PIN")
        self.assertEqual(request_code(at(request(), ["runner", "export"], "")), "RUNNER_PIN")

    def test_the_manifest_name_must_follow_the_v4_grammar_and_never_be_scoped(self) -> None:
        # The scoped distribution identity lives in `package`; a manifest name
        # that carried it would be one the shared extension contract refuses.
        def named(value: Json) -> str | None:
            return request_code(at(request(), ["runner", "manifestName"], value))

        for refused in ["@ezcorp/reference-data", "ReferenceData", "", "1-lead", "-lead", "under_score", "a" * 65]:
            self.assertEqual(named(refused), "RUNNER_MANIFEST_NAME", refused)
        self.assertEqual(request_code(without(request(), ["runner", "manifestName"])), "RUNNER_REQUEST_SCHEMA")
        for admitted in ["a", "a" * 64, "reference-data-9"]:
            self.assertIsNone(named(admitted), admitted)

    def test_the_manifest_name_grammar_is_the_v4_one(self) -> None:
        self.assertTrue(is_manifest_name("reference-data"))
        self.assertFalse(is_manifest_name("@ezcorp/reference-data"))
        self.assertFalse(is_manifest_name(7))
        self.assertFalse(is_manifest_name("A"))

    def test_the_runner_model_pin_must_be_bounded_and_digest_shaped(self) -> None:
        forged = at(request(), ["runner", "model"], "")
        self.assertEqual(request_code(without(forged, ["model"])), "RUNNER_MODEL_PIN")
        drifted = at(request(), ["runner", "configurationDigest"], "sha256:zz")
        self.assertEqual(request_code(without(drifted, ["model"])), "RUNNER_MODEL_PIN")

    def test_the_model_block_must_agree_with_the_runner_reference(self) -> None:
        self.assertEqual(request_code(at(request(), ["model", "model"], "other-model")), "RUNNER_MODEL_PIN")
        self.assertEqual(
            request_code(at(request(), ["model", "configurationDigest"], f"sha256:{DIGEST}")), "RUNNER_MODEL_PIN"
        )
        self.assertEqual(request_code(at(request(), ["model", "provider"], "")), "RUNNER_MODEL_PIN")
        self.assertEqual(request_code(at(request(), ["model", "policyDigest"], DIGEST)), "RUNNER_MODEL_PIN")
        bare = without(without(request(), ["runner", "model"]), ["runner", "configurationDigest"])
        self.assertIsNone(request_code(bare))

    def test_broker_authority_and_grants_must_be_bounded_and_unique(self) -> None:
        self.assertEqual(request_code(at(request(), ["broker", "attemptToken"], "")), "RUNNER_GRANT")
        self.assertEqual(request_code(at(request(), ["broker", "audience"], "")), "RUNNER_GRANT")
        self.assertEqual(request_code(at(request(), ["grants"], ["a", "a"])), "RUNNER_GRANT")
        self.assertEqual(request_code(at(request(), ["grants"], [""])), "RUNNER_GRANT")

    def test_resource_bounds_must_be_safe_counters_and_unsigned_decimal_cost(self) -> None:
        self.assertEqual(request_code(at(request(), ["resources", "maxCostMicros"], "01200")), "RUNNER_RESOURCES")
        self.assertEqual(request_code(at(request(), ["resources", "resourceClass"], "")), "RUNNER_RESOURCES")
        self.assertEqual(request_code(at(request(), ["resources", "maxTokens"], -1)), "RUNNER_RESOURCES")

    def test_an_artifact_input_is_validated_as_a_reference(self) -> None:
        artifact = at(
            request(),
            ["input"],
            {"kind": "artifact", "artifact": {"artifactId": "in", "digest": f"sha256:{DIGEST}", "encodedBytes": 4}},
        )
        self.assertIsNone(request_code(artifact))
        self.assertEqual(request_code(at(artifact, ["input", "artifact", "artifactId"], "a/b")), "RUNNER_ARTIFACT_ID")
        self.assertEqual(request_code(at(artifact, ["input", "artifact", "artifactId"], "a\\b")), "RUNNER_ARTIFACT_ID")
        self.assertEqual(request_code(at(artifact, ["input", "artifact", "digest"], DIGEST)), "RUNNER_DIGEST")
        self.assertEqual(request_code(at(artifact, ["input", "artifact", "encodedBytes"], -1)), "RUNNER_ARTIFACT_BYTES")

    def test_an_inline_input_beyond_the_inline_limit_is_refused(self) -> None:
        # The two limits are equal today and an envelope always encloses its own
        # inline value, so the envelope check answers first. They are separate
        # constants in both runtimes, and the inline rule is stated here against
        # a lowered one so that a future divergence stays covered rather than
        # becoming an unreachable branch.
        self.assertEqual(request_code(at(request(), ["input", "value"], {"p": "x" * 65_400})), "RUNNER_WIRE_BYTES")
        with mock.patch.object(factory_validation, "MAX_INLINE_VALUE_BYTES", 8):
            self.assertEqual(request_code(request()), "RUNNER_INLINE_BYTES")

    def test_the_next_operation_index_must_continue_the_checkpoint(self) -> None:
        checkpointed = at(
            request(),
            ["checkpoint"],
            {"artifactId": "cp", "digest": f"sha256:{DIGEST}", "encodedBytes": 8, "journalCursor": 4},
        )
        self.assertEqual(request_code(checkpointed), "RUNNER_CURSOR")
        self.assertIsNone(request_code(at(checkpointed, ["authority", "nextOperationIndex"], 5)))
        self.assertEqual(request_code(at(request(), ["authority", "nextOperationIndex"], 1)), "RUNNER_CURSOR")

    def test_a_checkpoint_is_validated_as_a_reference_and_a_cursor(self) -> None:
        checkpointed = at(
            request(),
            ["checkpoint"],
            {"artifactId": "cp", "digest": f"sha256:{DIGEST}", "encodedBytes": 8, "journalCursor": -1},
        )
        self.assertIsNone(request_code(checkpointed))
        self.assertEqual(request_code(at(checkpointed, ["checkpoint", "digest"], DIGEST)), "RUNNER_DIGEST")
        self.assertEqual(request_code(at(checkpointed, ["checkpoint", "journalCursor"], -2)), "RUNNER_CURSOR")

    def test_tool_declarations_must_be_uniquely_named_and_carry_valid_schemas(self) -> None:
        self.assertEqual(request_code(at(request(), ["tools", 0, "name"], "")), "RUNNER_TOOL")
        self.assertEqual(request_code(at(request(), ["tools", 0, "description"], "d" * 4_097)), "RUNNER_TOOL")
        duplicated = at(request(), ["tools"], [request()["tools"][0], request()["tools"][0]])
        self.assertEqual(request_code(duplicated), "RUNNER_TOOL")
        # A keyword the generated PortSchema forbids never reaches the port rules.
        self.assertEqual(
            request_code(at(request(), ["tools", 0, "inputSchema"], {"type": "string", "pattern": "^a$"})),
            "RUNNER_REQUEST_SCHEMA",
        )
        # A shape the generated schema admits but the port rules refuse.
        self.assertEqual(
            request_code(at(request(), ["tools", 0, "inputSchema"], {"type": "object", "required": ["absent"]})),
            "RUNNER_TOOL_SCHEMA",
        )
        with_output = at(request(), ["tools", 0, "outputSchema"], {"type": "string"})
        self.assertIsNone(request_code(with_output))
        self.assertEqual(
            request_code(at(with_output, ["tools", 0, "outputSchema"], {"type": "object", "required": ["absent"]})),
            "RUNNER_TOOL_SCHEMA",
        )


class RunnerResultTest(unittest.TestCase):
    def test_the_canonical_result_is_accepted(self) -> None:
        self.assertIsNone(result_code(result()))

    def test_a_value_outside_the_generated_schema_is_refused_first(self) -> None:
        self.assertEqual(result_code({}), "RUNNER_RESULT_SCHEMA")
        self.assertEqual(result_code(at(result(), ["status"], "unknown")), "RUNNER_RESULT_SCHEMA")

    def test_an_envelope_beyond_the_wire_limit_is_refused(self) -> None:
        # 200 operations of ~400 canonical bytes each clear 64 KiB while every
        # operation stays individually valid.
        first = result()["operations"][0]
        operations = []
        for index in range(200):
            entry = at(first, ["operationIndex"], index)
            entry = at(entry, ["operationId"], f"{'padding-' * 40}operation:{index}")
            entry = at(entry, ["workspaceCheckpoint", "journalCursor"], index)
            operations.append(entry)
        oversized = at(at(result(), ["operations"], operations), ["journalCursor"], 199)
        oversized = at(oversized, ["workspaceCheckpoint", "journalCursor"], 199)
        self.assertEqual(result_code(oversized), "RUNNER_WIRE_BYTES")

    def test_the_result_cursor_must_be_a_safe_integer_at_or_above_minus_one(self) -> None:
        empty = at(at(result(), ["operations"], []), ["journalCursor"], -2)
        self.assertEqual(result_code(empty), "RUNNER_CURSOR")

    def test_operations_must_be_strictly_ordered_by_index(self) -> None:
        first = result()["operations"][0]
        repeated = at(result(), ["operations"], [first, first])
        self.assertEqual(result_code(repeated), "RUNNER_OPERATION_ORDER")

    def test_an_operation_identity_must_end_with_its_own_index(self) -> None:
        self.assertEqual(
            result_code(at(result(), ["operations", 0, "operationId"], "operation-python:1")), "RUNNER_OPERATION"
        )
        self.assertEqual(result_code(at(result(), ["operations", 0, "operationId"], "")), "RUNNER_OPERATION")
        self.assertEqual(result_code(at(result(), ["operations", 0, "requestDigest"], "zz")), "RUNNER_OPERATION")
        self.assertEqual(result_code(at(result(), ["operations", 0, "resultDigest"], "zz")), "RUNNER_OPERATION")
        self.assertEqual(
            result_code(at(result(), ["operations", 0, "providerReceiptDigest"], "zz")), "RUNNER_OPERATION"
        )
        self.assertIsNone(result_code(at(result(), ["operations", 0, "providerReceiptDigest"], DIGEST)))

    def test_an_uncertain_operation_may_omit_its_result_digest_but_not_advance_the_cursor(self) -> None:
        unknown_usage = {"kind": "unknown", "reason": "provider timeout", "heldCostMicros": "500"}
        uncertain = at(at(result(), ["operations", 0, "state"], "uncertain"), ["journalCursor"], -1)
        uncertain = without(uncertain, ["operations", 0, "workspaceCheckpoint"])
        uncertain = without(uncertain, ["operations", 0, "resultDigest"])
        uncertain = at(uncertain, ["operations", 0, "usage"], unknown_usage)
        uncertain = at(uncertain, ["operations", 0, "providerReceiptDigest"], DIGEST)
        uncertain = at(uncertain, ["workspaceCheckpoint", "journalCursor"], -1)
        self.assertIsNone(result_code(uncertain))
        self.assertEqual(result_code(at(uncertain, ["operations", 0, "resultDigest"], "zz")), "RUNNER_OPERATION")
        advanced = at(at(uncertain, ["journalCursor"], 0), ["workspaceCheckpoint", "journalCursor"], 0)
        self.assertEqual(result_code(advanced), "RUNNER_OPERATION_CURSOR")

    def test_a_settled_operation_cannot_exceed_the_cursor(self) -> None:
        ahead = at(result(), ["operations", 0, "operationIndex"], 1)
        ahead = at(ahead, ["operations", 0, "operationId"], "operation-python:1")
        self.assertEqual(result_code(ahead), "RUNNER_OPERATION_CURSOR")

    def test_a_completed_operation_checkpoint_must_equal_its_index(self) -> None:
        drifted = at(result(), ["operations", 0, "workspaceCheckpoint", "journalCursor"], 3)
        self.assertEqual(result_code(drifted), "RUNNER_OPERATION_CURSOR")

    def test_operation_usage_is_validated(self) -> None:
        self.assertEqual(result_code(at(result(), ["operations", 0, "usage", "costMicros"], "01200")), "RUNNER_USAGE")

    def test_an_operation_may_omit_usage_and_a_checkpoint_entirely(self) -> None:
        failed_operation = {
            "operationId": "operation-python:0",
            "operationIndex": 0,
            "kind": "tool",
            "requestDigest": DIGEST,
            "state": "failed",
            "resultDigest": OTHER_DIGEST,
        }
        value = at(self.failed(), ["operations"], [failed_operation])
        value = at(value, ["journalCursor"], 0)
        self.assertIsNone(result_code(value))

    def test_an_operation_checkpoint_is_validated_as_a_reference(self) -> None:
        self.assertEqual(
            result_code(at(result(), ["operations", 0, "workspaceCheckpoint", "digest"], DIGEST)), "RUNNER_DIGEST"
        )

    def test_measured_and_unknown_usage_each_have_their_own_rule(self) -> None:
        self.assertEqual(result_code(at(result(), ["usage", "inputTokens"], -1)), "RUNNER_USAGE")
        self.assertEqual(result_code(at(result(), ["usage", "outputTokens"], -1)), "RUNNER_USAGE")
        self.assertEqual(result_code(at(result(), ["usage", "computeMs"], -1)), "RUNNER_USAGE")
        # A completed result must carry measured usage, so unknown usage is
        # only reachable through a failed one.
        unknown = at(
            self.failed(), ["usage"], {"kind": "unknown", "reason": "provider timeout", "heldCostMicros": "500"}
        )
        self.assertIsNone(result_code(unknown))
        self.assertEqual(result_code(at(unknown, ["usage", "reason"], "")), "RUNNER_USAGE")
        self.assertEqual(result_code(at(unknown, ["usage", "heldCostMicros"], "007")), "RUNNER_USAGE")

    def test_the_result_checkpoint_must_match_the_result_cursor(self) -> None:
        self.assertEqual(result_code(at(result(), ["workspaceCheckpoint", "journalCursor"], 3)), "RUNNER_CURSOR")
        self.assertEqual(result_code(at(result(), ["workspaceCheckpoint", "digest"], DIGEST)), "RUNNER_DIGEST")

    def test_a_completed_result_needs_a_digest_and_an_output_reference(self) -> None:
        self.assertEqual(result_code(at(result(), ["resultDigest"], "zz")), "RUNNER_DIGEST")
        self.assertEqual(result_code(at(result(), ["output", "digest"], OTHER_DIGEST)), "RUNNER_DIGEST")

    @staticmethod
    def failed() -> Json:
        value = at(result(), ["status"], "failed")
        value = without(without(value, ["output"]), ["workspaceCheckpoint"])
        value["operations"] = []
        value["journalCursor"] = -1
        value["error"] = {"code": "GUEST_REFUSED", "message": "refused", "retryable": False}
        return value

    def test_a_failed_result_needs_a_digest_and_a_structured_bounded_error(self) -> None:
        failed = self.failed()
        self.assertIsNone(result_code(failed))
        self.assertEqual(result_code(at(failed, ["error", "code"], "")), "RUNNER_FAILURE")
        self.assertEqual(result_code(at(failed, ["error", "message"], "m" * 4_097)), "RUNNER_FAILURE")
        self.assertEqual(result_code(at(failed, ["resultDigest"], "zz")), "RUNNER_FAILURE")

    def test_an_uncertain_result_needs_a_provider_receipt_digest(self) -> None:
        uncertain = at(result(), ["status"], "uncertain")
        uncertain = without(without(uncertain, ["output"]), ["resultDigest"])
        uncertain["operations"] = []
        uncertain["journalCursor"] = -1
        uncertain = without(uncertain, ["workspaceCheckpoint"])
        uncertain["usage"] = {"kind": "unknown", "reason": "provider timeout", "heldCostMicros": "500"}
        uncertain["providerReceiptDigest"] = DIGEST
        self.assertIsNone(result_code(uncertain))
        self.assertEqual(result_code(at(uncertain, ["providerReceiptDigest"], "zz")), "RUNNER_UNCERTAIN")
        self.assertEqual(result_code({**uncertain, "resultDigest": "zz"}), "RUNNER_UNCERTAIN")
        self.assertIsNone(result_code({**uncertain, "resultDigest": OTHER_DIGEST}))


if __name__ == "__main__":
    unittest.main()
