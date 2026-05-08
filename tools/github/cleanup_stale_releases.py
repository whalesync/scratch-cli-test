#!/usr/bin/env python3
"""
Identify and delete stale Scratch Desktop or CLI releases on GitHub.

Matches draft or prerelease releases older than --days (default: test=3, prod=7).
Releases are matched by tag shape so a published prod release is never
considered. Default is dry-run; pass --apply to actually delete.

Usage:
  ./cleanup_stale_releases.py --app desktop --variant test --token <gh_token>
  ./cleanup_stale_releases.py --app cli --variant prod --token <gh_token> --apply
  ./cleanup_stale_releases.py --app desktop --variant test --days 5
  GITHUB_TOKEN=... ./cleanup_stale_releases.py --app cli --variant test
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

REPOS = {
    "desktop": "whalesync/scratch-desktop",
    "cli": "whalesync/scratch-cli",
}

TAG_PATTERNS = {
    "prod": re.compile(r"^v\d+\.\d+\.\d+$"),
    "test": re.compile(r"^v\d+\.\d+\.\d+-test$"),
}


def parse_args():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "--app",
        choices=["desktop", "cli"],
        required=True,
        help="Which app's releases to scan (desktop=whalesync/scratch-desktop, cli=whalesync/scratch-cli).",
    )
    p.add_argument(
        "--variant",
        choices=["prod", "test"],
        required=True,
        help="Which release variant to scan.",
    )
    p.add_argument(
        "--token",
        default=os.environ.get("GITHUB_TOKEN"),
        help="GitHub API token. Falls back to $GITHUB_TOKEN.",
    )
    p.add_argument(
        "--days",
        type=float,
        default=None,
        help="Age threshold in days for draft and prerelease releases. Defaults: test=3, prod=7.",
    )
    p.add_argument(
        "--apply",
        action="store_true",
        help="Actually delete matching releases. Default is dry-run.",
    )
    args = p.parse_args()
    if args.days is not None and args.days < 0:
        p.error("--days must be non-negative")
    return args


def gh_request(method, path, token):
    req = Request(
        f"https://api.github.com{path}",
        method=method,
        headers={
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "scratch-desktop-cleanup",
        },
    )
    with urlopen(req) as r:
        body = r.read()
        return r.status, body


def list_all_releases(repo, token):
    releases = []
    page = 1
    while True:
        _, body = gh_request("GET", f"/repos/{repo}/releases?per_page=100&page={page}", token)
        batch = json.loads(body.decode())
        if not batch:
            break
        releases.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return releases


def parse_iso8601(ts):
    # GitHub returns "YYYY-MM-DDTHH:MM:SSZ"
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def threshold_for(variant, days_override):
    if days_override is not None:
        return timedelta(days=days_override)
    return timedelta(days=3) if variant == "test" else timedelta(days=7)


def evaluate(release, variant, now, threshold):
    tag = release.get("tag_name") or ""
    if not TAG_PATTERNS[variant].match(tag):
        return None

    is_draft = release.get("draft", False)
    is_prerelease = release.get("prerelease", False)
    if is_draft:
        state = "draft"
    elif is_prerelease:
        state = "prerelease"
    else:
        return None

    # For drafts, published_at is null; created_at is the only signal.
    # For prereleases, published_at reflects when it actually went live.
    ts_str = release.get("published_at") if state == "prerelease" else None
    ts_str = ts_str or release.get("created_at")
    age = now - parse_iso8601(ts_str)
    if age <= threshold:
        return None

    return {
        "id": release["id"],
        "tag": tag,
        "state": state,
        "age": age,
    }


def format_age(td):
    days = td.days
    hours = td.seconds // 3600
    return f"{days}d{hours:02d}h"


def main():
    args = parse_args()
    if not args.token:
        print("ERROR: --token (or $GITHUB_TOKEN) is required.", file=sys.stderr)
        return 2

    repo = REPOS[args.app]
    now = datetime.now(timezone.utc)
    threshold = threshold_for(args.variant, args.days)

    print(f"Scanning {repo} for stale {args.variant} releases...")
    print(f"  age threshold: > {threshold}")

    try:
        releases = list_all_releases(repo, args.token)
    except HTTPError as e:
        print(f"ERROR: GitHub API HTTP {e.code}: {e.read().decode(errors='replace')}", file=sys.stderr)
        return 1
    except URLError as e:
        print(f"ERROR: Network error: {e}", file=sys.stderr)
        return 1

    matches = [m for m in (evaluate(r, args.variant, now, threshold) for r in releases) if m]

    if not matches:
        print("No stale releases found.")
        return 0

    matches.sort(key=lambda m: m["age"], reverse=True)
    print(f"\nFound {len(matches)} stale {args.variant} release(s):")
    print(f"  {'STATE':<11} {'TAG':<28} {'AGE':<8} {'ID'}")
    for m in matches:
        print(f"  {m['state']:<11} {m['tag']:<28} {format_age(m['age']):<8} {m['id']}")

    if not args.apply:
        print("\n(dry run) Re-run with --apply to delete these releases.")
        return 0

    print("\nDeleting...")
    failures = 0
    for m in matches:
        try:
            status, _ = gh_request("DELETE", f"/repos/{repo}/releases/{m['id']}", args.token)
            if status == 204:
                print(f"  deleted {m['tag']} (id={m['id']})")
            else:
                print(f"  unexpected HTTP {status} deleting {m['tag']} (id={m['id']})")
                failures += 1
        except HTTPError as e:
            print(f"  failed to delete {m['tag']} (id={m['id']}): HTTP {e.code} {e.read().decode(errors='replace')}")
            failures += 1
        except URLError as e:
            print(f"  failed to delete {m['tag']} (id={m['id']}): {e}")
            failures += 1

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
