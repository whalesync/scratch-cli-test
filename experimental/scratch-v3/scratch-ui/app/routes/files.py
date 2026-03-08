import asyncio
import io
import json
import zipfile

import scratch_engine
from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import Response, StreamingResponse

from app import csv_convert, db, services
from app.config import settings
from app.routes._helpers import (
    build_field_tree,
    build_folder_table,
    dirty_map,
    flatten_folders,
    format_value,
    get_dirty_files,
    get_file,
    is_htmx,
    json_field_changes,
    list_files_in_folder,
    normalize,
    parse_git_content,
    read_files_batch,
    render,
    repo_id_for_folder,
    shell,
)

router = APIRouter()
GIT_URL = settings.git_service_url


@router.get("/w/{workbook_id}/files")
async def files_index(
    request: Request,
    workbook_id: str,
):
    if not is_htmx(request):
        return await shell(request, workbook_id, content_url=f"/w/{workbook_id}/files")
    folders = db.list_data_folders(workbook_id)
    all_folders = flatten_folders(folders)
    return render(
        request,
        "partials/folder.html",
        workbook_id=workbook_id,
        path="/",
        items=[{"name": f.get("name", ""), "path": f.get("path", ""), "type": "FOLDER"} for f in all_folders],
    )


@router.get("/w/{workbook_id}/tree/{folder_id}")
async def tree_expand(
    request: Request,
    workbook_id: str,
    folder_id: str,
):
    folders = db.list_data_folders(workbook_id)
    all_folders = flatten_folders(folders)
    folder = next((f for f in all_folders if f["id"] == folder_id), None)
    if not folder:
        return render(request, "partials/tree.html", workbook_id=workbook_id, items=[], dirty_paths={})

    items = await list_files_in_folder(workbook_id, folder)
    dirty_files = await get_dirty_files(workbook_id)

    return render(
        request,
        "partials/tree.html",
        workbook_id=workbook_id,
        items=items,
        dirty_paths=dirty_map(dirty_files),
    )


@router.get("/w/{workbook_id}/files/{path:path}")
async def file_view(
    request: Request,
    workbook_id: str,
    path: str,
    view: str = "auto",
):
    full_path = normalize(path)

    if not is_htmx(request):
        return await shell(request, workbook_id)

    if "." in path.split("/")[-1]:
        file_data = await get_file(workbook_id, full_path)
        file_detail = file_data.get("file", file_data)

        is_json = full_path.endswith(".json")
        if is_json and view != "raw":
            content = parse_git_content(file_detail)
            if isinstance(content, dict) and content:
                has_fields_wrapper = "fields" in content and isinstance(content["fields"], dict)
                display_obj = content.get("fields", content) if has_fields_wrapper else content

                record_name = full_path.rsplit("/", 1)[-1]
                if record_name.endswith(".json"):
                    record_name = record_name[:-5]

                # If file has changes and view isn't explicitly "record", show changes
                original = file_detail.get("originalContent")
                if original is not None and view != "record":
                    changes = json_field_changes(original, file_detail.get("content"))
                    if changes:
                        field_tree = build_field_tree(display_obj)
                        changes_by_path = {c["field"]: c for c in changes}
                        return render(
                            request,
                            "partials/record-diff.html",
                            workbook_id=workbook_id,
                            path=full_path,
                            record_name=record_name,
                            field_tree=field_tree,
                            changes=changes,
                            changes_by_path=changes_by_path,
                            format_value=format_value,
                        )

                field_tree = build_field_tree(display_obj)
                schema_labels: dict[str, dict] = {}

                return render(
                    request,
                    "partials/record-viewer.html",
                    workbook_id=workbook_id,
                    path=full_path,
                    record_name=record_name,
                    field_tree=field_tree,
                    schema_labels=schema_labels,
                    format_value=format_value,
                    has_fields_wrapper=has_fields_wrapper,
                )

        return render(
            request,
            "partials/editor.html",
            workbook_id=workbook_id,
            file=file_detail,
            path=full_path,
            is_json=is_json,
        )

    # Folder — table view
    folders = db.list_data_folders(workbook_id)
    all_folders = flatten_folders(folders)
    target_folder = None
    for f in all_folders:
        if (f.get("path") or "").rstrip("/") == full_path.rstrip("/"):
            target_folder = f

    if not target_folder:
        return render(
            request,
            "partials/folder.html",
            workbook_id=workbook_id,
            folder=target_folder,
            items=[],
            path=full_path,
        )

    items = await list_files_in_folder(workbook_id, target_folder)
    file_items = [i for i in items if i.get("type") == "file" and not i.get("name", "").startswith(".")]
    dirty_files = await get_dirty_files(workbook_id)

    columns, rows = await build_folder_table(workbook_id, target_folder, file_items, dirty_map(dirty_files))

    return render(
        request,
        "partials/folder-table.html",
        workbook_id=workbook_id,
        folder=target_folder,
        columns=columns,
        rows=rows,
        path=full_path,
    )


@router.patch("/w/{workbook_id}/files/{path:path}/field")
async def file_field_save(
    request: Request,
    workbook_id: str,
    path: str,
):
    form = await request.form()
    field_path = form.get("field_path", "")
    new_value_raw = form.get("value", "")

    try:
        new_value = json.loads(new_value_raw)
    except (json.JSONDecodeError, TypeError):
        new_value = new_value_raw

    try:
        await services.write_file_field(workbook_id, normalize(path), field_path, new_value)
        return render(request, "partials/status.html", message="Saved", status="success")
    except LookupError:
        return render(request, "partials/status.html", message="Folder not found", status="error")
    except Exception as e:
        return render(request, "partials/status.html", message=f"Error: {e}", status="error")


@router.patch("/w/{workbook_id}/files/{path:path}")
async def file_save(
    request: Request,
    workbook_id: str,
    path: str,
    content: str = Form(""),
):
    try:
        await services.write_file_content(workbook_id, normalize(path), content)
        return render(request, "partials/status.html", message="Saved", status="success")
    except LookupError:
        return render(request, "partials/status.html", message="Folder not found", status="error")
    except Exception as e:
        return render(request, "partials/status.html", message=f"Error: {e}", status="error")


async def _resolve_folder_files(
    workbook_id: str, path: str
) -> tuple[dict | None, list[dict]]:
    """Resolve a folder from path and read all its file contents from git."""
    full_path = normalize(path)
    folders = db.list_data_folders(workbook_id)
    all_folders = flatten_folders(folders)
    target_folder = None
    for f in all_folders:
        if (f.get("path") or "").rstrip("/") == full_path.rstrip("/"):
            target_folder = f
    if not target_folder:
        return None, []

    items = await list_files_in_folder(workbook_id, target_folder)
    file_items = [i for i in items if i.get("type") == "file" and not i.get("name", "").startswith(".")]

    workbook = db.get_workbook(workbook_id)
    if not workbook or not file_items:
        return target_folder, []

    rid = repo_id_for_folder(target_folder, workbook)
    paths = [i.get("path", "").lstrip("/") for i in file_items]
    batch = await read_files_batch(rid, paths, branch="dirty")
    return target_folder, batch


@router.get("/w/{workbook_id}/download/{path:path}/zip")
async def download_zip(
    workbook_id: str,
    path: str,
):
    folder, batch = await _resolve_folder_files(workbook_id, path)
    folder_name = (folder.get("name", "folder") if folder else "folder")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in batch:
            file_path = item.get("path", "")
            filename = file_path.rsplit("/", 1)[-1] if "/" in file_path else file_path
            content = item.get("content", "")
            zf.writestr(filename, content)
    buf.seek(0)

    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{folder_name}.zip"'},
    )


@router.get("/w/{workbook_id}/download/{path:path}/json")
async def download_json(
    workbook_id: str,
    path: str,
):
    folder, batch = await _resolve_folder_files(workbook_id, path)
    folder_name = (folder.get("name", "folder") if folder else "folder")

    records = []
    for item in batch:
        parsed = parse_git_content(item)
        name = item.get("path", "").rsplit("/", 1)[-1]
        if name.endswith(".json"):
            name = name[:-5]
        records.append({"name": name, **parsed})

    payload = json.dumps(records, indent=2)
    return Response(
        content=payload,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{folder_name}.json"'},
    )


@router.get("/w/{workbook_id}/download/{path:path}/csv")
async def download_csv(
    workbook_id: str,
    path: str,
):
    folder, batch = await _resolve_folder_files(workbook_id, path)
    folder_name = (folder.get("name", "folder") if folder else "folder")

    records = []
    names = []
    for item in batch:
        parsed = parse_git_content(item)
        name = item.get("path", "").rsplit("/", 1)[-1]
        if name.endswith(".json"):
            name = name[:-5]
        records.append(parsed)
        names.append(name)

    csv_string = csv_convert.export_records(records, names)
    return Response(
        content=csv_string,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{folder_name}.csv"'},
    )


@router.post("/w/{workbook_id}/upload/{path:path}/csv")
async def upload_csv(
    request: Request,
    workbook_id: str,
    path: str,
    file: UploadFile = File(...),
):
    csv_bytes = await file.read()
    csv_string = csv_bytes.decode("utf-8-sig")

    full_path = normalize(path)
    folder, batch = await _resolve_folder_files(workbook_id, path)
    if not folder:
        return render(request, "partials/status.html", message="Folder not found", status="error")

    # Build originals dict: stem → parsed record, and a path lookup
    originals = {}
    stem_to_git_path = {}
    for item in batch:
        parsed = parse_git_content(item)
        git_path = item.get("path", "")
        name = git_path.rsplit("/", 1)[-1]
        stem = name[:-5] if name.endswith(".json") else name
        originals[stem] = parsed
        stem_to_git_path[stem] = git_path.lstrip("/")

    changes = csv_convert.merge_records(csv_string, originals)

    if not changes:
        return render(request, "partials/status.html", message="No changes detected", status="info")

    # Write changed records back to git
    workbook = db.get_workbook(workbook_id)
    if not workbook:
        return render(request, "partials/status.html", message="Workbook not found", status="error")

    try:
        rid = repo_id_for_folder(folder, workbook)
        write_ops = []
        total_fields = 0
        for stem, updated_record, change_count in changes:
            git_path = stem_to_git_path.get(stem)
            if git_path:
                write_ops.append({"path": git_path, "content": json.dumps(updated_record, indent=2, ensure_ascii=False)})
                total_fields += change_count

        if write_ops:
            await asyncio.to_thread(
                scratch_engine.git_write_files, GIT_URL, rid, json.dumps(write_ops), "dirty"
            )
    except Exception as e:
        return render(request, "partials/status.html", message=f"Error writing: {e}", status="error")

    # Re-read updated folder to render refreshed table
    items = await list_files_in_folder(workbook_id, folder)
    file_items = [i for i in items if i.get("type") == "file" and not i.get("name", "").startswith(".")]
    dirty_files = await get_dirty_files(workbook_id)
    columns, rows = await build_folder_table(workbook_id, folder, file_items, dirty_map(dirty_files))

    message = f"{len(changes)} record{'s' if len(changes) != 1 else ''}, {total_fields} field{'s' if total_fields != 1 else ''} changed"
    return render(
        request,
        "partials/folder-table.html",
        workbook_id=workbook_id,
        folder=folder,
        columns=columns,
        rows=rows,
        path=full_path,
        upload_message=message,
    )
