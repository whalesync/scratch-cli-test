from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request

from app import db, services
from app.routes._helpers import (
    build_summary,
    get_dirty_files,
    get_file,
    is_htmx,
    json_field_changes,
    normalize,
    render,
    resolve_push_label,
    shell,
    truncate,
    word_diff,
)

router = APIRouter()


@router.get("/w/{workbook_id}/publish")
async def publish_page(
    request: Request,
    workbook_id: str,
):
    if not is_htmx(request):
        return await shell(request, workbook_id, content_url=f"/w/{workbook_id}/publish")

    dirty_files = await get_dirty_files(workbook_id)
    folders = db.list_data_folders(workbook_id)
    push_label = resolve_push_label(dirty_files, folders) if dirty_files else "Publish"

    return render(
        request,
        "partials/publish.html",
        workbook_id=workbook_id,
        dirty_files=dirty_files,
        push_label=push_label,
    )


@router.get("/w/{workbook_id}/review")
async def review(
    request: Request,
    workbook_id: str,
    view: str = "table",
):
    if view not in ("diff", "table", "summary"):
        view = "table"
    if not is_htmx(request):
        return await shell(request, workbook_id)

    dirty_files = await get_dirty_files(workbook_id)
    folders = db.list_data_folders(workbook_id)
    push_label = resolve_push_label(dirty_files, folders) if dirty_files else "Push"

    enriched_files = []
    if view in ("table", "summary") and dirty_files:

        async def _enrich(f: dict) -> dict:
            fpath = normalize(f.get("path", ""))
            try:
                file_data = await get_file(workbook_id, fpath)
                detail = file_data.get("file", file_data)
                original = detail.get("originalContent")
                modified = detail.get("content")
                changes = json_field_changes(original, modified)
                is_json = bool(changes) or (original and modified)
            except Exception:
                changes = []
                is_json = False
            return {**f, "path": fpath, "changes": changes, "is_json": is_json}

        enriched_files = await asyncio.gather(*[_enrich(f) for f in dirty_files])

    summary = build_summary(enriched_files) if enriched_files else {}

    return render(
        request,
        "partials/review.html",
        workbook_id=workbook_id,
        dirty_files=dirty_files,
        enriched_files=enriched_files,
        summary=summary,
        view=view,
        truncate=truncate,
        push_label=push_label,
    )


@router.get("/w/{workbook_id}/review/{path:path}")
async def review_file(
    request: Request,
    workbook_id: str,
    path: str,
):
    full_path = normalize(path)
    if not is_htmx(request):
        return await shell(request, workbook_id)

    file_data = await get_file(workbook_id, full_path)
    file_detail = file_data.get("file", file_data)

    diff_html = None
    original = file_detail.get("originalContent")
    modified = file_detail.get("content")
    if original is not None and modified is not None and original != modified:
        diff_html = word_diff(original, modified)

    return render(
        request,
        "partials/diff.html",
        workbook_id=workbook_id,
        file=file_detail,
        path=full_path,
        diff_html=diff_html,
    )


@router.post("/w/{workbook_id}/review/publish")
async def publish(
    request: Request,
    workbook_id: str,
):
    form_data = await request.form()
    path = form_data.get("path", "")
    try:
        await services.publish_file(workbook_id, path)
        return render(request, "partials/status.html", message=f"Pushed {path}", status="success")
    except LookupError:
        return render(request, "partials/status.html", message="Folder not found", status="error")
    except Exception as e:
        return render(request, "partials/status.html", message=f"Error: {e}", status="error")


@router.post("/w/{workbook_id}/review/publish-all")
async def publish_all(
    request: Request,
    workbook_id: str,
):
    result = await services.publish_all_files(workbook_id)
    published = result["published"]
    errors = result["errors"]

    if errors:
        msg = f"Pushed {published}, failed {len(errors)}: {'; '.join(errors)}"
        status = "error"
    else:
        msg = f"Pushed {published} file{'s' if published != 1 else ''}"
        status = "success"

    remaining = await get_dirty_files(workbook_id)
    if remaining:
        folders = db.list_data_folders(workbook_id)
        push_label = resolve_push_label(remaining, folders)
        return render(
            request,
            "partials/review.html",
            workbook_id=workbook_id,
            dirty_files=remaining,
            enriched_files=[],
            view="table",
            publish_message=msg,
            publish_status=status,
            push_label=push_label,
        )
    return render(request, "partials/empty.html", message=msg, status=status)


@router.post("/w/{workbook_id}/review/push")
async def push_to_service(
    request: Request,
    workbook_id: str,
):
    """Push dirty changes to external services (background)."""
    try:
        await services.start_push(workbook_id)
    except LookupError:
        return render(request, "partials/status.html", message="Workbook not found", status="error")
    return render(request, "partials/status.html", message="Push started — check Runs for progress", status="info")


@router.post("/w/{workbook_id}/review/discard")
async def discard(
    request: Request,
    workbook_id: str,
):
    form_data = await request.form()
    path = form_data.get("path")
    try:
        if path:
            await services.discard_changes(workbook_id, path)
            return render(request, "partials/status.html", message=f"Discarded {path}", status="success")
        return render(request, "partials/empty.html", message="Discarded all changes", status="success")
    except LookupError:
        return render(request, "partials/status.html", message="Folder not found", status="error")
    except Exception as e:
        return render(request, "partials/status.html", message=f"Error: {e}", status="error")
