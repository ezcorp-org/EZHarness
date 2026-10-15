"""The reference image pack's pure modules.

Everything here runs on the standard library alone. The PNG reader, the
normalizing encoder, the OCR threshold, the claim shapes, and the drawn fixtures
need no imaging library and no model runtime, which is what lets the pack's
byte-level decisions be measured on any host rather than only inside the guest
image. The one module that touches a model, `sdxl`, imports it lazily and takes
its pipeline as an argument.
"""

__all__ = ["claims", "fixtures", "ocr_report", "png_format", "png_normalize", "sdxl"]
