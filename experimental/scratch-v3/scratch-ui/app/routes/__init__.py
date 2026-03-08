"""Route autodiscovery. Each .py file in this directory is a FastAPI router."""

from __future__ import annotations

import importlib
import pkgutil
from pathlib import Path

from fastapi import APIRouter

router = APIRouter()


def _discover_routers() -> None:
    """Import every module in this package and include its router."""
    pkg_dir = Path(__file__).parent
    for importer, module_name, is_pkg in pkgutil.iter_modules([str(pkg_dir)]):
        if module_name.startswith("_"):
            continue
        module = importlib.import_module(f"app.routes.{module_name}")
        if hasattr(module, "router"):
            router.include_router(module.router)


_discover_routers()
