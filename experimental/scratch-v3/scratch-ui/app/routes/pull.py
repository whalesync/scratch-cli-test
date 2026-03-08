"""Pull routes — fetch records from external services into git (background)."""

from __future__ import annotations

from fastapi import APIRouter, Request

from app import services
from app.routes._helpers import render

router = APIRouter()


@router.post("/w/{workbook_id}/pull")
async def pull_all(request: Request, workbook_id: str):
    """Start a background pull for all connected folders."""
    try:
        await services.start_pull(workbook_id)
    except LookupError:
        return render(request, "partials/status.html", message="Workbook not found", status="error")
    return render(request, "partials/status.html", message="Pull started — check Runs for progress", status="info")


@router.post("/w/{workbook_id}/pull/{connector_account_id}")
async def pull_connection(
    request: Request,
    workbook_id: str,
    connector_account_id: str,
):
    """Start a background pull for folders belonging to one connection."""
    try:
        await services.start_pull(workbook_id, connector_account_id)
    except LookupError as e:
        return render(request, "partials/status.html", message=str(e), status="error")
    return render(request, "partials/status.html", message="Pulling connection…", status="info")
