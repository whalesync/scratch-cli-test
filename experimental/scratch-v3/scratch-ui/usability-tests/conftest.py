"""Fixtures for Playwright usability tests.

Starts scratch-ui on a test port (reuses running scratch-git-2),
discovers a workbook from the live home page, and provides browser pages.
"""

from __future__ import annotations

import signal
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parent.parent  # scratch-ui/

APP_PORT = 18765
APP_URL = f"http://localhost:{APP_PORT}"


# ---------------------------------------------------------------------------
# Session-scoped: start the app once for all tests
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def base_url():
    """Start scratch-ui, wait for it, yield the URL, then tear down."""
    proc = subprocess.Popen(
        [
            sys.executable, "-m", "uvicorn", "app.main:app",
            "--port", str(APP_PORT),
            "--host", "127.0.0.1",
        ],
        cwd=str(ROOT),
        env=_base_env(),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    _wait_for(f"{APP_URL}/", timeout=15)
    yield APP_URL
    proc.send_signal(signal.SIGTERM)
    proc.wait(timeout=5)


@pytest.fixture(scope="session")
def browser_context_args():
    return {"ignore_https_errors": True}


# ---------------------------------------------------------------------------
# Per-test: fresh page
# ---------------------------------------------------------------------------


@pytest.fixture()
def page(browser, base_url):
    ctx = browser.new_context(
        base_url=base_url,
        viewport={"width": 1920, "height": 1080},
    )
    pg = ctx.new_page()
    yield pg
    pg.close()
    ctx.close()


# ---------------------------------------------------------------------------
# Helpers (not fixtures)
# ---------------------------------------------------------------------------


def _base_env():
    import os
    env = os.environ.copy()
    env["GIT_SERVICE_URL"] = env.get("GIT_SERVICE_URL", "http://localhost:3100")
    return env


def _wait_for(url: str, timeout: int = 10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            r = httpx.get(url, timeout=2, follow_redirects=True)
            if r.status_code < 500:
                return
        except Exception:
            pass
        time.sleep(0.5)
    raise TimeoutError(f"Service did not start within {timeout}s at {url}")
