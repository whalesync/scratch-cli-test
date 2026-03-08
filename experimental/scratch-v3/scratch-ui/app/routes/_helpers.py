"""Shared route helpers. Prefixed with _ so autodiscovery skips it."""

from __future__ import annotations

import asyncio
import difflib
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

import scratch_engine
from fastapi import Request
from fastapi.templating import Jinja2Templates
from markupsafe import Markup, escape

from app import db
from app.config import settings

BASE_DIR = Path(__file__).resolve().parent.parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
GIT_URL = settings.git_service_url


def is_htmx(request: Request) -> bool:
    return request.headers.get("HX-Request") == "true"


def normalize(path: str) -> str:
    return f"/{path}" if not path.startswith("/") else path


def dirty_map(files: list[dict]) -> dict[str, str]:
    return {normalize(f.get("path", "")): f.get("status", "modified") for f in files}


def render(request: Request, template: str, **ctx):
    user = getattr(request.state, "user", None)
    return templates.TemplateResponse(template, {"request": request, "user": user, **ctx})


def word_diff(original: str, modified: str) -> Markup:
    orig_tokens = re.findall(r"\S+|\s+", original)
    mod_tokens = re.findall(r"\S+|\s+", modified)
    sm = difflib.SequenceMatcher(None, orig_tokens, mod_tokens)
    parts: list[str] = []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            parts.append(str(escape("".join(orig_tokens[i1:i2]))))
        elif op == "delete":
            parts.append("<del>" + str(escape("".join(orig_tokens[i1:i2]))) + "</del>")
        elif op == "insert":
            parts.append("<ins>" + str(escape("".join(mod_tokens[j1:j2]))) + "</ins>")
        elif op == "replace":
            parts.append("<del>" + str(escape("".join(orig_tokens[i1:i2]))) + "</del>")
            parts.append("<ins>" + str(escape("".join(mod_tokens[j1:j2]))) + "</ins>")
    return Markup("".join(parts))


def json_field_changes(original_str: str | None, modified_str: str | None) -> list[dict]:
    if not original_str and not modified_str:
        return []
    try:
        original = json.loads(original_str) if original_str else {}
        modified = json.loads(modified_str) if modified_str else {}
    except (json.JSONDecodeError, TypeError):
        return []
    if isinstance(original, dict) and isinstance(modified, dict):
        if "fields" in original or "fields" in modified:
            original = original.get("fields", {})
            modified = modified.get("fields", {})
    if not isinstance(original, dict) or not isinstance(modified, dict):
        return []

    def _diff_dicts(old_obj, new_obj, prefix=""):
        results = []
        all_keys = sorted(set(list(old_obj.keys()) + list(new_obj.keys())))
        for key in all_keys:
            path = f"{prefix}.{key}" if prefix else key
            old_val = old_obj.get(key)
            new_val = new_obj.get(key)
            if old_val == new_val:
                continue
            if isinstance(old_val, dict) and isinstance(new_val, dict):
                results.extend(_diff_dicts(old_val, new_val, path))
            else:
                old_str = str(old_val) if old_val is not None else None
                new_str = str(new_val) if new_val is not None else None
                diff_html = None
                if old_str and new_str:
                    diff_html = word_diff(old_str, new_str)
                results.append({"field": path, "old_value": old_val, "new_value": new_val, "diff_html": diff_html})
        return results

    return _diff_dicts(original, modified)


def truncate(value, max_len: int = 80) -> str:
    s = str(value) if value is not None else ""
    return s if len(s) <= max_len else s[:max_len] + "..."


def build_summary(enriched_files: list[dict]) -> dict:
    status_counts: Counter = Counter()
    for f in enriched_files:
        status_counts[f.get("status", "modified")] += 1
    folder_counts: Counter = Counter()
    for f in enriched_files:
        parts = f["path"].strip("/").split("/")
        folder = "/" + parts[0] if parts else "/"
        folder_counts[folder] += 1
    field_freq: Counter = Counter()
    fields_emptied: Counter = Counter()
    for f in enriched_files:
        status = f.get("status", "modified")
        for c in f.get("changes", []):
            field_freq[c["field"]] += 1
            if status not in ("deleted", "added"):
                old, new = c.get("old_value"), c.get("new_value")
                if old and not new:
                    fields_emptied[c["field"]] += 1
    total = len(enriched_files)
    anomalies = []
    if total > 5:
        threshold = max(2, total * 0.1)
        for field, count in field_freq.items():
            if count <= threshold:
                anomalies.append({"field": field, "count": count})
    for field, count in fields_emptied.items():
        anomalies.append({"field": field, "count": count, "type": "emptied"})
    return {
        "total": total,
        "status_counts": dict(status_counts),
        "folder_counts": dict(folder_counts.most_common()),
        "field_freq": dict(field_freq.most_common()),
        "anomalies": anomalies,
    }


def active_nav(content_url: str) -> str:
    if "/publish" in content_url:
        return "publish"
    if "/review" in content_url:
        return "review"
    if "/connections" in content_url:
        return "connections"
    if "/syncs" in content_url:
        return "syncs"
    if "/runs" in content_url:
        return "history"
    if "/files" in content_url:
        return "files"
    return "files"


def flatten_folders(groups: list[dict]) -> list[dict]:
    result: list[dict] = []
    for item in groups:
        if "dataFolders" in item and isinstance(item["dataFolders"], list):
            result.extend(item["dataFolders"])
        else:
            result.append(item)
    return result


def find_folder_for_path(file_path: str, folders: list[dict]) -> dict | None:
    all_folders = flatten_folders(folders)
    for f in all_folders:
        fp = (f.get("path") or "").rstrip("/")
        if fp and file_path.startswith(fp + "/"):
            return f
    return None


def find_folder_id_for_path(file_path: str, folders: list[dict]) -> str | None:
    f = find_folder_for_path(file_path, folders)
    return f.get("id") if f else None


def repo_id_for_folder(folder: dict, workbook: dict) -> str:
    """Build the scratch-git-2 repo ID from folder + workbook metadata."""
    org_id = workbook.get("organization_id", "")
    wid = workbook.get("id", "")
    cid = folder.get("connectorAccountId") or folder.get("connector_account_id", "")
    return f"{org_id}--{wid}--{cid}"


def all_repo_ids(workbook: dict, folders: list[dict]) -> list[str]:
    """Return unique repo IDs for all connections in a workbook."""
    org_id = workbook.get("organization_id", "")
    wid = workbook.get("id", "")
    seen = set()
    result = []
    for f in flatten_folders(folders):
        cid = f.get("connectorAccountId") or f.get("connector_account_id", "")
        if cid and cid not in seen:
            seen.add(cid)
            result.append(f"{org_id}--{wid}--{cid}")
    return result


def set_nested_value(obj: dict, path: str, value: Any) -> None:
    parts = re.sub(r"\[(\d+)\]", r".\1", path).split(".")
    cur = obj
    for part in parts[:-1]:
        if isinstance(cur, list):
            cur = cur[int(part)]
        else:
            cur = cur.setdefault(part, {})
    last = parts[-1]
    if isinstance(cur, list):
        cur[int(last)] = value
    else:
        cur[last] = value


def resolve_push_label(dirty_files: list[dict], folders: list[dict]) -> str:
    all_folders_flat = flatten_folders(folders)
    service_names: set[str] = set()
    for f in dirty_files:
        fpath = normalize(f.get("path", ""))
        for folder in all_folders_flat:
            fp = (folder.get("path") or "").rstrip("/")
            if fp and fpath.startswith(fp + "/"):
                svc = folder.get("connectorService") or folder.get("connector_service") or folder.get("service", "")
                if svc:
                    service_names.add(svc)
                break
    if len(service_names) == 1:
        svc = next(iter(service_names))
        return f"Publish to {svc.replace('_', ' ').title()}"
    return "Publish"


async def shell(request: Request, workbook_id: str, content_url: str | None = None):
    workbook = db.get_workbook(workbook_id)
    folders = db.list_data_folders(workbook_id)
    workbooks = db.list_workbooks()
    resolved_url = content_url or str(request.url.path)
    return render(
        request,
        "shell.html",
        workbook=workbook,
        workbooks=workbooks,
        folders=folders,
        content_url=resolved_url,
        active_nav=active_nav(resolved_url),
    )


def build_field_tree(obj: dict, prefix: str = "", depth: int = 0) -> list[dict]:
    if depth > 3:
        return []
    nodes: list[dict] = []
    for key, value in obj.items():
        if key.startswith("_"):
            continue
        path = f"{prefix}.{key}" if prefix else key
        node: dict[str, Any] = {"key": key, "path": path, "value": value}
        if isinstance(value, list) and any(isinstance(v, dict) for v in value):
            children = []
            for i, item in enumerate(value):
                item_path = f"{path}[{i}]"
                if isinstance(item, dict):
                    children.append(
                        {
                            "key": f"{key}[{i}]",
                            "path": item_path,
                            "value": item,
                            "children": build_field_tree(item, item_path, depth + 1),
                        }
                    )
                else:
                    children.append({"key": f"{key}[{i}]", "path": item_path, "value": item})
            node["children"] = children
        elif isinstance(value, dict):
            node["children"] = build_field_tree(value, path, depth + 1)
        nodes.append(node)
    return nodes


def resolve_value(obj: dict, path: str) -> Any:
    parts = re.sub(r"\[(\d+)\]", r".\1", path).split(".")
    cur: Any = obj
    for part in parts:
        if cur is None or not isinstance(cur, (dict, list)):
            return None
        if isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return None
        else:
            cur = cur.get(part)
    return cur


def format_value(val: Any) -> str:
    if val is None:
        return "\u2014"
    if isinstance(val, str):
        return val if val else '""'
    if isinstance(val, (int, float, bool)):
        return str(val)
    if isinstance(val, list):
        if len(val) == 0:
            return "[]"
        if all(isinstance(v, (str, int, float)) for v in val):
            s = ", ".join(str(v) for v in val)
            return s if len(s) <= 120 else s[:120] + "\u2026"
        return f"[{len(val)} item{'s' if len(val) != 1 else ''}]"
    if isinstance(val, dict):
        keys = [k for k in val if not k.startswith("_")]
        return "{" + f"{len(keys)} field{'s' if len(keys) != 1 else ''}" + "}"
    return str(val)


def parse_git_content(data: dict) -> dict:
    """Parse JSON content from scratch-git-2 file response."""
    raw = data.get("content", "")
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return {}
    if isinstance(raw, dict):
        return raw
    return {}


def decode_mapper_state(form_data) -> dict:
    raw = form_data.get("state", "{}")
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {}


async def get_dirty_files(workbook_id: str) -> list[dict]:
    """Get dirty files across all repos for a workbook."""
    workbook = db.get_workbook(workbook_id)
    folders = db.list_data_folders(workbook_id)
    repo_ids = all_repo_ids(workbook, folders)
    if not repo_ids:
        return []

    dirty_json = await asyncio.to_thread(
        scratch_engine.git_get_dirty_files, GIT_URL, json.dumps(repo_ids)
    )
    return json.loads(dirty_json)


async def get_file(workbook_id: str, path: str) -> dict:
    """Read a file from the right repo, return NestJS-compatible shape."""
    workbook = db.get_workbook(workbook_id)
    folders = db.list_data_folders(workbook_id)
    folder = find_folder_for_path(path, folders)
    if not folder or not workbook:
        return {"file": {"content": "", "path": path}}
    rid = repo_id_for_folder(folder, workbook)

    result_json = await asyncio.to_thread(scratch_engine.git_read_file, GIT_URL, rid, path)
    result = json.loads(result_json)

    return {
        "file": {
            "path": path,
            "content": result.get("content", ""),
            "originalContent": result.get("originalContent"),
        }
    }


async def list_files_in_folder(workbook_id: str, folder: dict) -> list[dict]:
    """List files in a folder from the right git repo."""
    workbook = db.get_workbook(workbook_id)
    if not workbook:
        return []
    rid = repo_id_for_folder(folder, workbook)
    folder_path = (folder.get("path") or "").lstrip("/")
    result_json = await asyncio.to_thread(
        scratch_engine.git_list_files, GIT_URL, rid, folder_path, "dirty"
    )
    return json.loads(result_json)


async def read_files_batch(repo_id: str, paths: list[str], branch: str = "dirty") -> list[dict]:
    """Read multiple files from a single repo in one batch."""
    result_json = await asyncio.to_thread(
        scratch_engine.git_read_files_batch, GIT_URL, repo_id, json.dumps(paths), branch
    )
    return json.loads(result_json)


async def build_folder_table(
    workbook_id: str,
    folder: dict,
    file_items: list[dict],
    dirty_paths: dict[str, str],
) -> tuple[list[dict], list[dict]]:
    columns: list[dict] = []

    # Fetch file contents (capped at 200)
    capped_items = file_items[:200]
    file_contents: list[dict] = []
    if capped_items:
        workbook = db.get_workbook(workbook_id)
        rid = repo_id_for_folder(folder, workbook) if workbook else ""
        if rid:
            paths = [i.get("path", "").lstrip("/") for i in capped_items]
            batch = await read_files_batch(rid, paths, branch="dirty")
            for item in batch:
                file_contents.append(parse_git_content(item))
        else:
            file_contents = [{} for _ in capped_items]

    if not columns and file_contents:
        key_freq: dict[str, int] = {}
        for fc in file_contents[:5]:
            obj = fc.get("fields", fc) if isinstance(fc, dict) and "fields" in fc else fc
            if isinstance(obj, dict):
                for k in obj:
                    if not k.startswith("_"):
                        key_freq[k] = key_freq.get(k, 0) + 1
        sorted_keys = sorted(key_freq, key=lambda k: -key_freq[k])
        for k in sorted_keys:
            columns.append({"key": k, "label": k})

    rows: list[dict] = []
    for i, item in enumerate(capped_items):
        item_path = normalize(item.get("path", ""))
        name = item.get("name", "")
        if name.endswith(".json"):
            name = name[:-5]
        status = dirty_paths.get(item_path, "")
        fc = file_contents[i] if i < len(file_contents) else {}
        obj = fc.get("fields", fc) if isinstance(fc, dict) and "fields" in fc else fc
        fields: dict[str, str] = {}
        if isinstance(obj, dict):
            for col in columns:
                val = obj.get(col["key"])
                fields[col["key"]] = format_value(val) if val is not None else ""
        rows.append({"name": name, "path": item_path, "status": status, "fields": fields})

    return columns, rows
