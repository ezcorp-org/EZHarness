"""Test package for the locked Python distribution.

Importing this package puts the distribution's own directory on ``sys.path``,
so every test module imports the runner modules by their plain names in both
layouts: the repository checkout and the staged guest workspace.
"""

from __future__ import annotations

import sys
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent
if str(PACKAGE) not in sys.path:
    sys.path.insert(0, str(PACKAGE))
