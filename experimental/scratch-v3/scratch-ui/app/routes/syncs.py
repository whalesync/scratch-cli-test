import asyncio
import json

from fastapi import APIRouter, Request

from app import db, services
from app.routes._helpers import (
    build_field_tree,
    decode_mapper_state,
    flatten_folders,
    format_value,
    get_file,
    is_htmx,
    list_files_in_folder,
    normalize,
    parse_git_content,
    render,
    resolve_value,
    shell,
)

router = APIRouter()


def _annotate_tree(
    nodes: list[dict],
    side: str,
    match_key: dict | None,
    src_mapped_set: set[str],
    dst_mapping_lookup: dict[str, str],
    dst_transformer_lookup: dict[str, dict | None] | None = None,
) -> None:
    if dst_transformer_lookup is None:
        dst_transformer_lookup = {}
    for node in nodes:
        if side == "source" and match_key and node["path"] == match_key["source"]:
            node["state"] = "key"
        elif side == "dest" and match_key and node["path"] == match_key["dest"]:
            node["state"] = "key"
        elif side == "source" and node["path"] in src_mapped_set:
            node["state"] = "mapped"
        elif side == "dest" and node["path"] in dst_mapping_lookup:
            node["state"] = "mapped"
            node["mapped_from"] = dst_mapping_lookup[node["path"]]
            node["transformer"] = dst_transformer_lookup.get(node["path"])
        if node.get("children"):
            _annotate_tree(node["children"], side, match_key, src_mapped_set, dst_mapping_lookup, dst_transformer_lookup)


TRANSFORMERS = [
    {"type": "slugify", "label": "Slugify"},
    {"type": "auto_convert", "label": "Auto Convert", "options": [
        {"key": "targetType", "label": "Target type", "input": "select", "required": True,
         "choices": [
             {"value": "string", "label": "String"}, {"value": "number", "label": "Number"},
             {"value": "integer", "label": "Integer"}, {"value": "boolean", "label": "Boolean"},
             {"value": "array", "label": "Array"},
         ]},
    ]},
    {"type": "string_to_number", "label": "String \u2192 Number"},
    {"type": "notion_to_html", "label": "Notion \u2192 HTML"},
    {"type": "airmark_to_html", "label": "AirMark \u2192 HTML"},
    {"type": "html_to_airmark", "label": "HTML \u2192 AirMark"},
    {"type": "webflow_option", "label": "Webflow Option"},
    {"type": "jsonpath", "label": "JSONPath", "options": [
        {"key": "expression", "label": "Expression", "input": "text", "required": True, "placeholder": "$.field.path"},
        {"key": "arrayHandling", "label": "Multiple results", "input": "select",
         "choices": [
             {"value": "first", "label": "First match"}, {"value": "array", "label": "Array"},
             {"value": "join_space", "label": "Join (space)"}, {"value": "join_comma", "label": "Join (comma)"},
         ]},
    ]},
]


def _get_transformer_label(t_type: str) -> str:
    for t in TRANSFORMERS:
        if t["type"] == t_type:
            return t["label"]
    return t_type


async def _render_mapper(request: Request, wid: str, state: dict):
    src_folder_id = state.get("src_folder_id", "")
    dst_folder_id = state.get("dst_folder_id", "")

    folders = db.list_data_folders(wid)
    all_folders = flatten_folders(folders)
    src_folder = next((f for f in all_folders if f["id"] == src_folder_id), None)
    dst_folder = next((f for f in all_folders if f["id"] == dst_folder_id), None)

    src_items = await list_files_in_folder(wid, src_folder) if src_folder else []
    dst_items = await list_files_in_folder(wid, dst_folder) if dst_folder else []
    src_records = [i for i in src_items if i.get("type") == "file" and not i.get("name", "").startswith(".")]
    dst_records = [i for i in dst_items if i.get("type") == "file" and not i.get("name", "").startswith(".")]

    record_idx = state.get("record_idx", 0)
    match_key = state.get("match_key")
    mappings: list[dict] = state.get("mappings", [])

    if record_idx >= len(src_records):
        record_idx = max(0, len(src_records) - 1)
    state["record_idx"] = record_idx

    src_content: dict = {}
    src_record = src_records[record_idx] if src_records else None
    if src_record:
        src_path = normalize(src_record.get("path", ""))
        src_data = await get_file(wid, src_path)
        src_content = parse_git_content(src_data.get("file", src_data))

    dst_content: dict = {}
    dst_record = None
    if match_key and src_content:
        src_match_val = resolve_value(src_content, match_key["source"])
        if src_match_val is not None and dst_records:
            dst_file_data = await asyncio.gather(
                *(get_file(wid, normalize(dr.get("path", ""))) for dr in dst_records)
            )
            for dr, dr_data in zip(dst_records, dst_file_data):
                dr_content = parse_git_content(dr_data.get("file", dr_data))
                if str(resolve_value(dr_content, match_key["dest"])) == str(src_match_val):
                    dst_record = dr
                    dst_content = dr_content
                    break
    elif dst_records:
        dst_record = dst_records[min(record_idx, len(dst_records) - 1)]
        dst_path = normalize(dst_record.get("path", ""))
        dst_data = await get_file(wid, dst_path)
        dst_content = parse_git_content(dst_data.get("file", dst_data))

    src_tree = build_field_tree(src_content)
    dst_tree = build_field_tree(dst_content)

    dst_mapping_lookup: dict[str, str] = {}
    dst_transformer_lookup: dict[str, dict | None] = {}
    src_mapped_set: set[str] = set()
    for m in mappings:
        dst_mapping_lookup[m["destinationColumnId"]] = m["sourceColumnId"]
        dst_transformer_lookup[m["destinationColumnId"]] = m.get("transformer")
        src_mapped_set.add(m["sourceColumnId"])

    _annotate_tree(src_tree, "source", match_key, src_mapped_set, dst_mapping_lookup, dst_transformer_lookup)
    _annotate_tree(dst_tree, "dest", match_key, src_mapped_set, dst_mapping_lookup, dst_transformer_lookup)

    phase = "map" if match_key else "match"
    sync_name = state.get("sync_name", "")
    if not sync_name and src_folder and dst_folder:
        sync_name = f"{src_folder.get('name', '')} \u2192 {dst_folder.get('name', '')}"
        state["sync_name"] = sync_name

    return render(
        request,
        "partials/sync-mapper.html",
        workbook_id=wid,
        state=json.dumps(state),
        phase=phase,
        match_key=match_key,
        mappings=mappings,
        sync_name=sync_name,
        record_idx=record_idx,
        src_records=src_records,
        dst_records=dst_records,
        src_folder=src_folder or {},
        dst_folder=dst_folder or {},
        src_record=src_record,
        dst_record=dst_record,
        src_tree=src_tree,
        dst_tree=dst_tree,
        src_content=src_content,
        dst_mapping_lookup=dst_mapping_lookup,
        src_mapped_set=src_mapped_set,
        format_value=format_value,
        resolve_value=resolve_value,
        transformers=TRANSFORMERS,
        get_transformer_label=_get_transformer_label,
    )


@router.get("/w/{workbook_id}/syncs")
async def syncs_list(request: Request, workbook_id: str):
    if not is_htmx(request):
        return await shell(request, workbook_id)
    syncs = db.list_syncs(workbook_id)
    return render(request, "partials/syncs.html", workbook_id=workbook_id, syncs=syncs)


@router.post("/w/{workbook_id}/syncs/{sync_id}/run")
async def run_sync(request: Request, workbook_id: str, sync_id: str):
    result = await services.execute_sync(sync_id, workbook_id)

    parts = []
    if result["created"]:
        parts.append(f"{result['created']} created")
    if result["updated"]:
        parts.append(f"{result['updated']} updated")
    if not parts:
        parts.append("No changes")
    summary = ", ".join(parts)
    if result["errors"]:
        summary += f" ({len(result['errors'])} error{'s' if len(result['errors']) != 1 else ''})"

    status = "error" if result["errors"] and not (result["created"] or result["updated"]) else "success"
    return render(request, "partials/status.html", message=summary, status=status)


@router.post("/w/{workbook_id}/syncs/{sync_id}/delete")
async def delete_sync(request: Request, workbook_id: str, sync_id: str):
    try:
        await services.delete_sync(workbook_id, sync_id)
    except Exception as e:
        return render(request, "partials/status.html", message=f"Error: {e}", status="error")
    syncs = db.list_syncs(workbook_id)
    return render(request, "partials/syncs.html", workbook_id=workbook_id, syncs=syncs)


@router.get("/w/{workbook_id}/syncs/new")
async def sync_new(request: Request, workbook_id: str):
    if not is_htmx(request):
        return await shell(request, workbook_id)
    folders = db.list_data_folders(workbook_id)
    all_folders = flatten_folders(folders)
    return render(request, "partials/sync-picker.html", workbook_id=workbook_id, folders=all_folders)


@router.post("/w/{workbook_id}/syncs/mapper")
async def sync_mapper_init(request: Request, workbook_id: str):
    form = await request.form()
    state = {
        "src_folder_id": form.get("src_folder_id", ""),
        "dst_folder_id": form.get("dst_folder_id", ""),
        "sync_id": form.get("sync_id", ""),
        "record_idx": 0,
        "match_key": None,
        "mappings": [],
        "sync_name": "",
    }
    return await _render_mapper(request, workbook_id, state)


@router.post("/w/{workbook_id}/syncs/mapper/action")
async def sync_mapper_action(request: Request, workbook_id: str):
    form = await request.form()
    state = decode_mapper_state(form)
    action = form.get("action", "")

    if action == "set-match-key":
        state["match_key"] = {"source": form.get("source_path", ""), "dest": form.get("dest_path", "")}

    elif action == "add-mapping":
        source_path = form.get("source_path", "")
        dest_path = form.get("dest_path", "")
        mappings = state.get("mappings", [])
        mappings = [m for m in mappings if m["destinationColumnId"] != dest_path]
        mappings.append({"sourceColumnId": source_path, "destinationColumnId": dest_path})
        state["mappings"] = mappings

    elif action == "remove-mapping":
        dest_path = form.get("dest_path", "")
        state["mappings"] = [m for m in state.get("mappings", []) if m["destinationColumnId"] != dest_path]

    elif action == "set-transformer":
        dest_path = form.get("dest_path", "")
        t_type = form.get("transformer_type", "")
        t_options_raw = form.get("transformer_options", "")
        t_options = {}
        if t_options_raw:
            try:
                t_options = json.loads(t_options_raw)
            except (json.JSONDecodeError, TypeError):
                pass
        transformer = {"type": t_type}
        if t_options:
            transformer["options"] = t_options
        mappings = state.get("mappings", [])
        for m in mappings:
            if m["destinationColumnId"] == dest_path:
                m["transformer"] = transformer
        state["mappings"] = mappings

    elif action == "remove-transformer":
        dest_path = form.get("dest_path", "")
        mappings = state.get("mappings", [])
        for m in mappings:
            if m["destinationColumnId"] == dest_path:
                m.pop("transformer", None)
        state["mappings"] = mappings

    elif action == "reset-match-key":
        state["match_key"] = None
        state["mappings"] = []

    elif action == "navigate-record":
        direction = form.get("direction", "")
        idx = state.get("record_idx", 0)
        state["record_idx"] = max(0, idx - 1) if direction == "prev" else idx + 1

    elif action == "update-name":
        state["sync_name"] = form.get("sync_name", "")

    elif action == "save":
        match_key = state.get("match_key")
        mappings = list(state.get("mappings", []))
        sync_name = state.get("sync_name", "Unnamed Sync")
        sync_id = state.get("sync_id", "")

        if not match_key:
            return render(request, "partials/status.html", message="Match key required", status="error")

        has_match = any(
            m["sourceColumnId"] == match_key["source"] and m["destinationColumnId"] == match_key["dest"]
            for m in mappings
        )
        if not has_match:
            mappings.insert(0, {"sourceColumnId": match_key["source"], "destinationColumnId": match_key["dest"]})

        payload = {
            "displayName": sync_name,
            "mappings": {
                "version": 1,
                "tableMappings": [
                    {
                        "sourceDataFolderId": state.get("src_folder_id"),
                        "destinationDataFolderId": state.get("dst_folder_id"),
                        "columnMappings": mappings,
                        "recordMatching": {
                            "sourceColumnId": match_key["source"],
                            "destinationColumnId": match_key["dest"],
                        },
                    }
                ],
            },
        }

        try:
            if sync_id:
                await services.update_sync(workbook_id, sync_id, payload)
            else:
                await services.create_sync(workbook_id, payload)
        except Exception as e:
            return render(request, "partials/status.html", message=f"Error: {e}", status="error")

        syncs = db.list_syncs(workbook_id)
        return render(request, "partials/syncs.html", workbook_id=workbook_id, syncs=syncs)

    return await _render_mapper(request, workbook_id, state)


@router.get("/w/{workbook_id}/syncs/{sync_id}/edit")
async def sync_edit(request: Request, workbook_id: str, sync_id: str):
    if not is_htmx(request):
        return await shell(request, workbook_id)

    sync = db.get_sync(workbook_id, sync_id)
    if not sync:
        return render(request, "partials/status.html", message="Sync not found", status="error")

    tm = (sync.get("mappings") or {}).get("tableMappings", [{}])[0] if sync.get("mappings") else {}
    if not tm:
        return render(request, "partials/status.html", message="No table mapping found", status="error")

    match_key_data = tm.get("recordMatching")
    match_key = None
    if match_key_data:
        match_key = {"source": match_key_data["sourceColumnId"], "dest": match_key_data["destinationColumnId"]}

    all_mappings = tm.get("columnMappings", [])
    mappings = all_mappings
    if match_key:
        mappings = [
            m
            for m in all_mappings
            if not (
                m["sourceColumnId"] == match_key["source"]
                and m["destinationColumnId"] == match_key["dest"]
                and not m.get("transformer")
            )
        ]

    state = {
        "src_folder_id": tm.get("sourceDataFolderId", ""),
        "dst_folder_id": tm.get("destinationDataFolderId", ""),
        "sync_id": sync_id,
        "record_idx": 0,
        "match_key": match_key,
        "mappings": mappings,
        "sync_name": sync.get("displayName", ""),
    }
    return await _render_mapper(request, workbook_id, state)
