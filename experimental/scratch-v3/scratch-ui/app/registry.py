"""Autodiscovery: scan a package directory and collect subclasses of a base class.

Drop a .py file in the right directory, it gets picked up at startup. No imports,
no registration, no touching other files.
"""

from __future__ import annotations

import importlib
import pkgutil
from pathlib import Path
from types import ModuleType


def autodiscover(package_path: str | list[str], base_class: type) -> dict[str, type]:
    """Scan a package directory for modules containing subclasses of base_class.

    Returns a dict keyed by the class's `name` attribute (or lowercased class name).
    """
    if isinstance(package_path, str):
        package_path = [package_path]

    pkg_dir = Path(package_path[0])
    pkg_name = _package_name_from_path(pkg_dir)

    found: dict[str, type] = {}
    for importer, module_name, is_pkg in pkgutil.iter_modules(package_path):
        if module_name.startswith("_") or module_name == "base":
            continue
        module = importlib.import_module(f"{pkg_name}.{module_name}")
        for cls in _find_subclasses(module, base_class):
            key = getattr(cls, "name", None) or cls.__name__.lower()
            found[key] = cls
    return found


def _package_name_from_path(pkg_dir: Path) -> str:
    """Derive dotted package name from filesystem path (e.g. app.connectors)."""
    parts = []
    current = pkg_dir
    while current.name != "app" and current.parent != current:
        parts.append(current.name)
        current = current.parent
    parts.append("app")
    return ".".join(reversed(parts))


def _find_subclasses(module: ModuleType, base_class: type) -> list[type]:
    """Find all concrete subclasses of base_class defined in module."""
    results = []
    for attr_name in dir(module):
        attr = getattr(module, attr_name)
        if (
            isinstance(attr, type)
            and issubclass(attr, base_class)
            and attr is not base_class
            and not getattr(attr, "__abstractmethods__", None)
            and attr.__module__ == module.__name__
        ):
            results.append(attr)
    return results
