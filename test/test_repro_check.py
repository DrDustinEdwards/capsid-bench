import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from importlib import import_module  # noqa: E402

repro = import_module("repro-check".replace("-", "_")) if False else None  # placeholder
