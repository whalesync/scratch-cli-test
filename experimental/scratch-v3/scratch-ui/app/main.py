from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from app.auth import auth_middleware
from app.config import settings
from app.connectors import connectors
from app.db import init_db
from app.routes import router
from app.routes._helpers import render, templates

BASE_DIR = Path(__file__).resolve().parent


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    app.state.connectors = connectors
    yield


app = FastAPI(title="Scratch UI", lifespan=lifespan)

app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")

# Auth middleware — must be added before routes
app.add_middleware(BaseHTTPMiddleware, dispatch=auth_middleware)


# -- Sign-in / Sign-out routes (public) --------------------------------------


@app.get("/sign-in")
async def sign_in(request: Request):
    return render(request, "sign-in.html", clerk_publishable_key=settings.clerk_publishable_key)


@app.post("/sign-out")
async def sign_out(request: Request):
    response = RedirectResponse(url="/sign-in", status_code=302)
    response.delete_cookie("__session")
    return response


# -- Error handlers -----------------------------------------------------------


@app.exception_handler(httpx.HTTPStatusError)
async def api_error_handler(request: Request, exc: httpx.HTTPStatusError):
    return templates.TemplateResponse(
        "error.html",
        {"request": request, "status": exc.response.status_code, "detail": str(exc)},
        status_code=502,
    )


@app.exception_handler(httpx.ConnectError)
async def connect_error_handler(request: Request, exc: httpx.ConnectError):
    return templates.TemplateResponse(
        "error.html",
        {"request": request, "status": 503, "detail": "Cannot reach external service"},
        status_code=503,
    )


@app.exception_handler(Exception)
async def generic_error_handler(request: Request, exc: Exception):
    return templates.TemplateResponse(
        "error.html",
        {"request": request, "status": 500, "detail": str(exc)},
        status_code=500,
    )


app.include_router(router)
