from fastapi import APIRouter, Request

from app import db
from app.routes._helpers import is_htmx, render, shell

router = APIRouter()


def _job_is_active(job: dict) -> bool:
    s = (job.get("state") or job.get("status") or "unknown").lower()
    return s in ("active", "waiting", "delayed", "created")


@router.get("/w/{workbook_id}/runs")
async def runs_list(request: Request, workbook_id: str):
    if not is_htmx(request):
        return await shell(request, workbook_id)
    jobs = db.list_jobs(workbook_id)
    return render(request, "partials/runs.html", workbook_id=workbook_id, jobs=jobs, job_is_active=_job_is_active)


@router.get("/w/{workbook_id}/runs/{job_id}")
async def run_row(request: Request, workbook_id: str, job_id: str):
    jobs = db.list_jobs(workbook_id)
    job = next((j for j in jobs if j.get("id") == job_id), None)
    if not job:
        return render(request, "partials/status.html", message="Job not found", status="error")
    return render(
        request, "partials/run-row.html", workbook_id=workbook_id, job=job, job_is_active=_job_is_active
    )


@router.post("/w/{workbook_id}/runs/{job_id}/cancel")
async def cancel_job(request: Request, workbook_id: str, job_id: str):
    db.update_job(job_id, "canceled")
    jobs = db.list_jobs(workbook_id)
    job = next((j for j in jobs if j.get("id") == job_id), None)
    if not job:
        return render(request, "partials/status.html", message="Job not found", status="error")
    return render(
        request, "partials/run-row.html", workbook_id=workbook_id, job=job, job_is_active=_job_is_active
    )
