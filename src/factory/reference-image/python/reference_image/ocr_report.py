"""Optical character recognition, and the threshold that turns it into a claim.

C10 states the rule precisely: no recognized text, where a recognized word is
one the pinned English validator reports at confidence sixty or above. Two parts
of that are easy to get wrong. A word below the threshold is not evidence of
text and must not fail the claim, and an engine that returns nothing is not the
same as an engine that ran and found nothing. The first distinction lives in
`recognized_words`; the second is why `read_words` separates a failed
invocation from an empty result.

The engine is invoked as a subprocess rather than through a binding, so the
pinned command and its arguments are visible in the evidence.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

#: The tab-separated columns tesseract writes with the `tsv` configuration.
TSV_TEXT_COLUMN = "text"
TSV_CONFIDENCE_COLUMN = "conf"


class OcrError(RuntimeError):
    """Raised when the engine could not produce a result at all.

    An engine that fails is inconclusive, never a pass. Callers turn this into a
    VALIDATOR_ERROR verdict rather than into "no text found".
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class OcrWord:
    """One recognized token and the engine's confidence in it."""

    text: str
    confidence: float


def parse_tsv(document: str) -> tuple[OcrWord, ...]:
    """Reads the engine's tab-separated output into words.

    Rows whose text is blank are layout rows rather than words and carry a
    confidence of minus one; they are dropped. A row that cannot be read as a
    number is a malformed result and stops the parse, because quietly skipping
    it would lower the measured word count.
    """
    lines = document.splitlines()
    if not lines:
        raise OcrError("ocr_output_empty", "The engine wrote no output at all")
    header = lines[0].split("\t")
    if TSV_TEXT_COLUMN not in header or TSV_CONFIDENCE_COLUMN not in header:
        raise OcrError("ocr_output_unreadable", "The engine output has no text and confidence columns")
    text_at = header.index(TSV_TEXT_COLUMN)
    confidence_at = header.index(TSV_CONFIDENCE_COLUMN)
    words: list[OcrWord] = []
    for number, line in enumerate(lines[1:], start=2):
        if not line.strip():
            continue
        fields = line.split("\t")
        if len(fields) <= max(text_at, confidence_at):
            raise OcrError("ocr_output_unreadable", f"Row {number} has fewer columns than the header")
        text = fields[text_at].strip()
        if not text:
            continue
        try:
            confidence = float(fields[confidence_at])
        except ValueError as error:
            raise OcrError("ocr_output_unreadable", f"Row {number} has a non-numeric confidence") from error
        words.append(OcrWord(text, confidence))
    return tuple(words)


def recognized_words(words: Sequence[OcrWord], minimum_confidence: int) -> tuple[OcrWord, ...]:
    """The words that count as recognized text at the locked threshold.

    The comparison is "at least", exactly as C10 writes it, so a word reported at
    the threshold itself is text.
    """
    return tuple(word for word in words if word.confidence >= minimum_confidence)


@dataclass(frozen=True)
class OcrOutcome:
    """What one OCR run measured, as the claim needs it."""

    command: tuple[str, ...]
    total_words: int
    recognized: tuple[OcrWord, ...]

    @property
    def has_text(self) -> bool:
        return len(self.recognized) > 0

    def summary(self) -> str:
        if not self.recognized:
            return f"No word reached the confidence threshold; {self.total_words} candidate token(s) were scored"
        shown = ", ".join(f"{word.text!r} at {word.confidence:g}" for word in self.recognized[:5])
        return f"{len(self.recognized)} recognized word(s): {shown}"


def tesseract_command(image_path: str, language: str, page_segmentation_mode: int, engine_mode: int) -> tuple[str, ...]:
    """The exact pinned invocation. Every argument comes from the lock."""
    return (
        "tesseract",
        image_path,
        "stdout",
        "-l",
        language,
        "--psm",
        str(page_segmentation_mode),
        "--oem",
        str(engine_mode),
        "tsv",
    )


def read_words(document: str, minimum_confidence: int, command: Sequence[str]) -> OcrOutcome:
    """Turns one engine invocation into a measured outcome."""
    words = parse_tsv(document)
    return OcrOutcome(tuple(command), len(words), recognized_words(words, minimum_confidence))
