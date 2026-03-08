"""Connection routes — create, test, discover tables, link, edit, delete."""

from __future__ import annotations

import json

from fastapi import APIRouter, Request

from app import db, services
from app.connectors import connectors
from app.routes._helpers import is_htmx, render, shell

router = APIRouter()


# ---------------------------------------------------------------------------
# List / picker
# ---------------------------------------------------------------------------


def _connector_services() -> dict:
    return {
        name.upper(): {
            "display_name": cls.display_name,
            "fields": cls.fields,
            "auth_type": cls.auth_type,
            "oauth_only": cls.oauth_only,
        }
        for name, cls in connectors.items()
    }


@router.get("/w/{workbook_id}/connections")
async def connections_list(request: Request, workbook_id: str):
    if not is_htmx(request):
        return await shell(request, workbook_id)
    connections = db.list_connections(workbook_id)
    return render(request, "partials/connections.html", workbook_id=workbook_id, connections=connections)


@router.get("/w/{workbook_id}/connections/new")
async def connection_picker(request: Request, workbook_id: str, service: str | None = None):
    services = _connector_services()
    if service and service in services:
        svc = services[service]
        return render(
            request, "partials/connect-form.html", workbook_id=workbook_id, service_key=service, service=svc
        )
    return render(request, "partials/connect-pick.html", workbook_id=workbook_id, services=services)


# ---------------------------------------------------------------------------
# Create connection → test → show table picker
# ---------------------------------------------------------------------------


@router.post("/w/{workbook_id}/connections")
async def connection_create(request: Request, workbook_id: str):
    form_data = await request.form()
    service_key = form_data.get("service", "")
    svc_map = _connector_services()
    svc = svc_map.get(service_key)
    if not svc:
        return render(request, "partials/status.html", message="Unknown service", status="error")

    display_name = form_data.get("displayName") or svc["display_name"]

    cls = connectors.get(service_key.lower())
    if not cls:
        return render(request, "partials/connect-done.html", workbook_id=workbook_id, count=0)

    creds: dict[str, str] = {}
    for field in cls.fields:
        val = form_data.get(field.name, "")
        if val:
            creds[field.name] = val

    try:
        conn_row = await services.create_connection(workbook_id, service_key, creds, display_name)
    except (ValueError, LookupError) as e:
        return render(
            request, "partials/connect-form.html",
            workbook_id=workbook_id, service_key=service_key, service=svc,
            error=str(e),
        )
    except Exception as e:
        return render(
            request, "partials/connect-form.html",
            workbook_id=workbook_id, service_key=service_key, service=svc,
            error=f"Connection failed: {e}",
        )

    # Discover tables for the table picker
    try:
        table_dicts = await services.discover_tables(conn_row["id"])
        # Serialize remoteId for form hidden fields
        table_dicts = [{"remoteId": json.dumps(t["remoteId"]), "name": t["name"]} for t in table_dicts]
    except Exception:
        table_dicts = []

    return render(
        request, "partials/connect-tables.html",
        workbook_id=workbook_id, conn_id=conn_row["id"], tables=table_dicts,
        service=service_key, display_name=display_name,
    )


# ---------------------------------------------------------------------------
# Link selected tables → create folders → background initial pull
# ---------------------------------------------------------------------------


@router.post("/w/{workbook_id}/connections/{conn_id}/link")
async def link_tables(
    request: Request,
    workbook_id: str,
    conn_id: str,
):
    form_data = await request.form()
    selected = form_data.getlist("tables")

    tables_to_link: list[dict] = []
    for table_json in selected:
        table_name = form_data.get(f"table_name_{table_json}", "")
        try:
            remote_id = json.loads(table_json)
        except (json.JSONDecodeError, TypeError):
            remote_id = [table_json]
        if not table_name:
            table_name = remote_id[-1] if isinstance(remote_id, list) and remote_id else str(remote_id)
        tables_to_link.append({"remoteId": remote_id, "name": table_name})

    try:
        await services.link_tables(workbook_id, conn_id, tables_to_link)
    except LookupError as e:
        return render(request, "partials/status.html", message=str(e), status="error")

    return render(request, "partials/connect-done.html", workbook_id=workbook_id, count=len(selected))


# ---------------------------------------------------------------------------
# Edit credentials
# ---------------------------------------------------------------------------


@router.get("/w/{workbook_id}/connections/{conn_id}/edit")
async def connection_edit_form(request: Request, workbook_id: str, conn_id: str):
    conn_row = db.get_connection(conn_id)
    if not conn_row:
        return render(request, "partials/status.html", message="Connection not found", status="error")

    service_key = conn_row["service"]
    cls = connectors.get(service_key.lower())
    svc = {
        "display_name": conn_row.get("displayName") or conn_row.get("display_name", service_key),
        "fields": cls.fields if cls else [],
        "auth_type": conn_row.get("auth_type", ""),
        "oauth_only": cls.oauth_only if cls else False,
    }

    # Decrypt current values for non-secret fields
    from app.engine import load_credentials
    current = load_credentials(conn_row)

    return render(
        request, "partials/connect-form.html",
        workbook_id=workbook_id, service_key=service_key.upper(), service=svc,
        conn_id=conn_id, current_values=current,
    )


@router.post("/w/{workbook_id}/connections/{conn_id}/edit")
async def connection_edit_save(request: Request, workbook_id: str, conn_id: str):
    conn_row = db.get_connection(conn_id)
    if not conn_row:
        return render(request, "partials/status.html", message="Connection not found", status="error")

    service_key = conn_row["service"]
    cls = connectors.get(service_key.lower())
    if not cls:
        return render(request, "partials/status.html", message="Unknown service", status="error")

    form_data = await request.form()
    display_name = form_data.get("displayName") or conn_row.get("displayName", service_key)

    # Merge: use new values where provided, keep old for blank secret fields
    from app.engine import load_credentials
    old_creds = load_credentials(conn_row)
    creds: dict[str, str] = {}
    for field in cls.fields:
        val = form_data.get(field.name, "")
        if val:
            creds[field.name] = val
        elif field.secret and old_creds.get(field.name):
            creds[field.name] = old_creds[field.name]

    # Test with new credentials
    try:
        connector = cls(creds)
        await connector.test_connection()
    except Exception as e:
        svc = {"display_name": display_name, "fields": cls.fields, "auth_type": cls.auth_type, "oauth_only": cls.oauth_only}
        return render(
            request, "partials/connect-form.html",
            workbook_id=workbook_id, service_key=service_key.upper(), service=svc,
            conn_id=conn_id, current_values=creds, error=f"Connection failed: {e}",
        )

    encrypted_json = services.encrypt_credentials(creds)
    db.update_connection(conn_id, encrypted_json, display_name)
    return render(request, "partials/status.html", message="Credentials updated", status="success")


# ---------------------------------------------------------------------------
# Test / discover / delete
# ---------------------------------------------------------------------------


@router.post("/w/{workbook_id}/connections/{conn_id}/test")
async def test_connection_route(request: Request, workbook_id: str, conn_id: str):
    try:
        await services.test_connection(conn_id)
        return render(request, "partials/status.html", message="Connection OK", status="success")
    except Exception as e:
        return render(request, "partials/status.html", message=f"Connection failed: {e}", status="error")


@router.post("/w/{workbook_id}/connections/{conn_id}/tables")
async def discover_tables_route(request: Request, workbook_id: str, conn_id: str):
    conn_row = db.get_connection(conn_id)
    if not conn_row:
        return render(request, "partials/status.html", message="Connection not found", status="error")
    try:
        table_dicts = await services.discover_tables(conn_id)
        table_dicts = [{"remoteId": json.dumps(t["remoteId"]), "name": t["name"]} for t in table_dicts]
        return render(
            request, "partials/connect-tables.html",
            workbook_id=workbook_id, conn_id=conn_id, tables=table_dicts,
            service=conn_row["service"],
            display_name=conn_row.get("displayName", conn_row["service"]),
        )
    except Exception as e:
        return render(request, "partials/status.html", message=f"Discovery failed: {e}", status="error")


@router.post("/w/{workbook_id}/connections/{conn_id}/delete")
async def delete_connection_route(request: Request, workbook_id: str, conn_id: str):
    try:
        await services.delete_connection(workbook_id, conn_id)
    except LookupError as e:
        return render(request, "partials/status.html", message=str(e), status="error")
    connections = db.list_connections(workbook_id)
    return render(request, "partials/connections.html", workbook_id=workbook_id, connections=connections)


