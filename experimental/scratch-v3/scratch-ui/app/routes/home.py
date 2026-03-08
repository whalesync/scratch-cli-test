from fastapi import APIRouter, Request
from fastapi.responses import RedirectResponse

from app import db
from app.routes._helpers import is_htmx, render, shell

router = APIRouter()


@router.get("/")
async def home(request: Request):
    user = getattr(request.state, "user", None)
    user_id = user.clerk_id if user else None

    # Upsert user on first visit
    if user:
        db.upsert_user(user.clerk_id, email=user.email, name=user.name)

    workbooks = db.list_workbooks(user_id=user_id)
    if len(workbooks) == 1:
        return RedirectResponse(url=f"/w/{workbooks[0]['id']}", status_code=302)
    return render(request, "home.html", workbooks=workbooks)


@router.get("/w/{workbook_id}")
async def workbook_root(request: Request, workbook_id: str):
    if not is_htmx(request):
        return await shell(request, workbook_id, content_url=f"/w/{workbook_id}/files")
    return RedirectResponse(url=f"/w/{workbook_id}/files", status_code=302)
