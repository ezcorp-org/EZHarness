"""Behaviour tests for the guest model contract in the Python runtime.

Every case names the issue code the shared contract requires. The C07
equivalence suite then compares those codes against the Bun validator over the
committed fixtures, so a bound that drifted in one runtime shows up as a
different code rather than as a value one runtime accepts and the other does
not.
"""

from __future__ import annotations

import unittest
from typing import Any

from factory_validation import (
    GUEST_MODEL_MAX_INPUT_BYTES,
    GUEST_MODEL_MAX_MESSAGE_BYTES,
    GUEST_MODEL_MAX_MESSAGES,
    GUEST_MODEL_MAX_OUTPUT_TOKENS,
    GUEST_MODEL_MAX_RESPONSE_BYTES,
    validate_factory_guest_model_request,
    validate_factory_guest_model_response,
)
from tests import (
    DIGEST,
    at,
    guest_model_refusal,
    guest_model_request,
    guest_model_response,
    guest_model_schemas,
    without,
)

GUEST_MODEL_REQUEST_SCHEMA, GUEST_MODEL_RESPONSE_SCHEMA = guest_model_schemas()

Json = Any


def request_code(value: Json) -> str | None:
    issue = validate_factory_guest_model_request(value, GUEST_MODEL_REQUEST_SCHEMA).issue
    return issue.code if issue else None


def response_code(value: Json) -> str | None:
    issue = validate_factory_guest_model_response(value, GUEST_MODEL_RESPONSE_SCHEMA).issue
    return issue.code if issue else None


class GuestModelRequestTests(unittest.TestCase):
    def test_the_canonical_request_is_admitted(self) -> None:
        self.assertIsNone(request_code(guest_model_request()))

    def test_a_value_outside_the_generated_schema_is_refused_before_any_semantics(self) -> None:
        self.assertEqual(request_code(None), "GUEST_MODEL_SCHEMA")
        self.assertEqual(request_code({}), "GUEST_MODEL_SCHEMA")
        bad_role = at(guest_model_request(), ["messages", 0, "role"], "tool")
        self.assertEqual(request_code(bad_role), "GUEST_MODEL_SCHEMA")
        self.assertEqual(request_code(without(guest_model_request(), ["model"])), "GUEST_MODEL_SCHEMA")

    def test_a_request_must_name_its_own_journalled_operation(self) -> None:
        for identifier in ("run:node:1:9", "", "x" * 1_025):
            asked = at(guest_model_request(), ["operationId"], identifier)
            self.assertEqual(request_code(asked), "GUEST_MODEL_OPERATION")
        # A negative index cannot name a journal row, whatever the id says.
        negative = guest_model_request(operationId="run-python:node-python:1:-1", operationIndex=-1)
        self.assertEqual(request_code(negative), "GUEST_MODEL_OPERATION")

    def test_the_output_bound_is_a_closed_interval(self) -> None:
        self.assertEqual(request_code(at(guest_model_request(), ["maxOutputTokens"], 0)), "GUEST_MODEL_OUTPUT")
        self.assertEqual(
            request_code(at(guest_model_request(), ["maxOutputTokens"], GUEST_MODEL_MAX_OUTPUT_TOKENS + 1)),
            "GUEST_MODEL_OUTPUT",
        )
        self.assertIsNone(request_code(at(guest_model_request(), ["maxOutputTokens"], GUEST_MODEL_MAX_OUTPUT_TOKENS)))
        self.assertIsNone(request_code(at(guest_model_request(), ["maxOutputTokens"], 1)))

    def test_the_message_count_is_bounded_at_both_ends(self) -> None:
        self.assertEqual(request_code(at(guest_model_request(), ["messages"], [])), "GUEST_MODEL_MESSAGES")
        one = [{"role": "user", "text": "t"}]
        self.assertIsNone(request_code(at(guest_model_request(), ["messages"], one)))
        self.assertIsNone(request_code(at(guest_model_request(), ["messages"], one * GUEST_MODEL_MAX_MESSAGES)))
        self.assertEqual(
            request_code(at(guest_model_request(), ["messages"], one * (GUEST_MODEL_MAX_MESSAGES + 1))),
            "GUEST_MODEL_MESSAGES",
        )

    def test_one_message_and_the_whole_input_carry_separate_byte_bounds(self) -> None:
        # A message just inside its own bound, three of which exceed the input bound.
        inside = "x" * (GUEST_MODEL_MAX_MESSAGE_BYTES - 2)
        self.assertIsNone(request_code(at(guest_model_request(), ["messages"], [{"role": "user", "text": inside}])))
        over_message = "x" * (GUEST_MODEL_MAX_MESSAGE_BYTES + 1)
        self.assertEqual(
            request_code(at(guest_model_request(), ["messages"], [{"role": "user", "text": over_message}])),
            "GUEST_MODEL_MESSAGES",
        )
        crowd = [{"role": "user", "text": inside} for _ in range(3)]
        self.assertEqual(request_code(at(guest_model_request(), ["messages"], crowd)), "GUEST_MODEL_INPUT_BYTES")
        self.assertGreater(3 * GUEST_MODEL_MAX_MESSAGE_BYTES, GUEST_MODEL_MAX_INPUT_BYTES)

    def test_a_multibyte_message_is_measured_in_bytes_not_characters(self) -> None:
        """Three bytes per character, so a string well short of the character
        bound still crosses the byte bound. Measuring characters here would let
        a guest send three times what the contract allows."""
        wide = "中" * (GUEST_MODEL_MAX_MESSAGE_BYTES // 3)
        self.assertLess(len(wide), GUEST_MODEL_MAX_MESSAGE_BYTES)
        self.assertEqual(
            request_code(at(guest_model_request(), ["messages"], [{"role": "user", "text": wide}])),
            "GUEST_MODEL_MESSAGES",
        )


class GuestModelResponseTests(unittest.TestCase):
    def test_a_completed_and_a_refused_response_are_both_admitted(self) -> None:
        self.assertIsNone(response_code(guest_model_response()))
        self.assertIsNone(response_code(guest_model_refusal()))

    def test_a_value_outside_the_generated_schema_is_refused(self) -> None:
        self.assertEqual(response_code(None), "GUEST_MODEL_SCHEMA")
        self.assertEqual(response_code(at(guest_model_response(), ["status"], "maybe")), "GUEST_MODEL_SCHEMA")
        # A completed answer cannot also carry a refusal.
        self.assertEqual(
            response_code({**guest_model_response(), "refusal": {"code": "invalid_request", "message": "no"}}),
            "GUEST_MODEL_SCHEMA",
        )

    def test_a_response_names_its_operation(self) -> None:
        self.assertEqual(response_code(at(guest_model_response(), ["operationId"], "")), "GUEST_MODEL_OPERATION")
        self.assertEqual(response_code(at(guest_model_refusal(), ["operationId"], "")), "GUEST_MODEL_OPERATION")

    def test_a_refusal_needs_a_bounded_message(self) -> None:
        self.assertEqual(response_code(at(guest_model_refusal(), ["refusal", "message"], "")), "GUEST_MODEL_REFUSAL")
        self.assertEqual(
            response_code(at(guest_model_refusal(), ["refusal", "message"], "m" * 4_097)),
            "GUEST_MODEL_REFUSAL",
        )
        self.assertIsNone(response_code(at(guest_model_refusal(), ["refusal", "message"], "m" * 4_096)))

    def test_a_completed_answer_is_bounded_and_carries_a_settleable_cost(self) -> None:
        over = "y" * (GUEST_MODEL_MAX_RESPONSE_BYTES + 1)
        self.assertEqual(response_code(at(guest_model_response(), ["text"], over)), "GUEST_MODEL_RESPONSE_BYTES")
        for receipt in ("zz", f"sha256:{DIGEST}x", "sha256:" + "Z" * 64):
            answered = at(guest_model_response(), ["providerReceiptDigest"], receipt)
            self.assertEqual(response_code(answered), "GUEST_MODEL_RECEIPT")
        # The bare form is what the reconciliation path refuses as tampering, so
        # this contract refuses it here instead of letting it reach the journal.
        self.assertEqual(
            response_code(at(guest_model_response(), ["providerReceiptDigest"], DIGEST)),
            "GUEST_MODEL_RECEIPT",
        )
        self.assertEqual(response_code(at(guest_model_response(), ["usage", "costMicros"], "-1")), "RUNNER_USAGE")
        self.assertEqual(response_code(at(guest_model_response(), ["usage", "inputTokens"], -1)), "RUNNER_USAGE")


if __name__ == "__main__":
    unittest.main()
