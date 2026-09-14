"""The pinned Python side of ``reference.data.v1``.

This package holds exactly three things: the strict row grammar C10 declares,
the PyArrow writer with C10's pinned serialisation settings, and the guest that
answers one attempt with one partition. It imports nothing from the network and
resolves nothing at execution time.

It lives beside the C02 conformance guest because both run under the one
committed ``uv.lock`` and the one ``.python-version`` pin, and because the guest
here reuses that guest's frame loop and its validators rather than writing a
second one.
"""
