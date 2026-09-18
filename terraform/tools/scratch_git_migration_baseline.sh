#!/usr/bin/env bash
#
# scratch-git disk-migration baseline recorder (DEV-11823) — READ-ONLY.
#
# Records disk usage, container state, and a per-repo ref + integrity fingerprint
# so a disk migration (test 50 GB / prod 2000 GB pd-ssd -> 20 / 200 GB pd-balanced)
# can be proven data-preserving. Run it three times and compare the "MANIFEST SHA256":
#
#   sudo bash scratch_git_migration_baseline.sh /mnt/disks/data     source   # AFTER stopping containers
#   sudo bash scratch_git_migration_baseline.sh /mnt/disks/data-new copy     # the rsync'd temp disk
#   sudo bash scratch_git_migration_baseline.sh /mnt/disks/data     after    # after the terraform restore
#
# The three MANIFEST SHA256 values must be identical. If one differs, diff the
# manifest-*.txt files to find the offending repo/ref.
#
# Run ON the scratch-git VM. It only reads (df / du / docker ps / git show-ref /
# git fsck, or a git-free ref read as fallback) and writes only under /tmp.
# It needs read access to the data dir, so run it as root via break-glass
# (role_operations@) SSH.
#
# IMPORTANT: output lives in /tmp on the VM, and the terraform recreate replaces
# the VM's BOOT disk too — so copy /tmp/scratch-git-baseline/* off the box (or just
# note the SHA256) BEFORE the recreate. The "source" and "copy" runs both happen
# before the recreate, so those two can be compared on the box directly.
#
# Env: BASELINE_FSCK=full|connectivity|none   (default: full)

set -uo pipefail
export LC_ALL=C

DATA_DIR="${1:-/mnt/disks/data}"
LABEL="${2:-$(basename "$DATA_DIR")}"
REPOS_DIR="$DATA_DIR/repos"
TS="$(date -u +%Y%m%d%H%M%S)"
OUT_DIR="/tmp/scratch-git-baseline"
FSCK_MODE="${BASELINE_FSCK:-full}"

mkdir -p "$OUT_DIR"
LOG="$OUT_DIR/report-$LABEL-$TS.txt"
MANIFEST="$OUT_DIR/manifest-$LABEL-$TS.txt"
FSCK_OUT="$OUT_DIR/fsck-$LABEL-$TS.txt"

exec > >(tee "$LOG") 2>&1

have_git=0
command -v git >/dev/null 2>&1 && have_git=1

echo "=================================================================="
echo " scratch-git baseline   label=$LABEL   $TS UTC"
echo " host=$(hostname)   data_dir=$DATA_DIR   fsck=$FSCK_MODE   host_git=$have_git"
echo "=================================================================="

echo; echo "### disk usage (df) ###"
df -hT "$DATA_DIR" 2>/dev/null || echo "(df failed for $DATA_DIR)"

echo; echo "### top-level usage (du, single filesystem) ###"
du -xsh "$DATA_DIR"/* 2>/dev/null | sort -rh || echo "(du failed)"

echo; echo "### containers (docker ps) ###"
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' 2>/dev/null \
  || echo "(docker not available to this user — restricted tier: use 'sudo gitops-ps')"

echo; echo "### repos under $REPOS_DIR ###"
if [[ ! -d "$REPOS_DIR" ]]; then
  echo "ERROR: no repos dir at $REPOS_DIR — is $DATA_DIR mounted?"
  exit 1
fi

# Emit "<ref>\t<sha>" for one bare repo. Prefer git (resolves loose-vs-packed
# correctly); fall back to reading refs off disk if the host has no git.
extract_refs() {
  local gd="$1"
  if [[ $have_git -eq 1 ]]; then
    git --git-dir="$gd" show-ref 2>/dev/null | awk 'NF==2 {print $2"\t"$1}'
  else
    if [[ -d "$gd/refs" ]]; then
      find "$gd/refs" -type f 2>/dev/null | while read -r rf; do
        printf '%s\t%s\n' "refs/${rf#"$gd"/refs/}" "$(<"$rf")"
      done
    fi
    [[ -f "$gd/packed-refs" ]] && awk '!/^#/ && !/^\^/ && NF==2 {print $2"\t"$1}' "$gd/packed-refs"
  fi
}

: > "$MANIFEST"
: > "$FSCK_OUT"
repo_count=0
fsck_bad=0

while IFS= read -r -d '' gitdir; do
  repo_count=$((repo_count + 1))
  rel="${gitdir#"$REPOS_DIR"/}"

  refs_out="$(extract_refs "$gitdir" | sort -u)"
  if [[ -n "$refs_out" ]]; then
    while IFS=$'\t' read -r ref sha; do
      [[ -n "$ref" ]] && printf '%s\t%s\t%s\n' "$rel" "$ref" "$sha" >> "$MANIFEST"
    done <<< "$refs_out"
  else
    printf '%s\t<NO-REFS>\t-\n' "$rel" >> "$MANIFEST"
  fi

  if [[ $have_git -eq 1 && "$FSCK_MODE" != "none" ]]; then
    fargs="--no-progress"
    [[ "$FSCK_MODE" == "connectivity" ]] && fargs="--no-progress --connectivity-only"
    if out="$(git --git-dir="$gitdir" fsck $fargs 2>&1)"; then
      printf '%s\tOK\t%s\n' "$rel" "$(printf '%s' "$out" | tr '\n' ';')" >> "$FSCK_OUT"
    else
      fsck_bad=$((fsck_bad + 1))
      printf '%s\tFAILED\t%s\n' "$rel" "$(printf '%s' "$out" | tr '\n' ';')" >> "$FSCK_OUT"
    fi
  fi
done < <(find "$REPOS_DIR" -type d -name '*.git' -prune -print0 | sort -z)

sort -o "$MANIFEST" "$MANIFEST"
MAN_SHA="$(sha256sum "$MANIFEST" | awk '{print $1}')"

echo "repos found:    $repo_count"
echo "refs recorded:  $(wc -l < "$MANIFEST" | tr -d ' ')"
if [[ $have_git -eq 1 && "$FSCK_MODE" != "none" ]]; then
  echo "fsck failures:  $fsck_bad"
else
  echo "fsck:           skipped (host_git=$have_git, mode=$FSCK_MODE)"
fi

echo; echo "### main / dirty heads (eyeball) ###"
grep -E $'\trefs/heads/(main|dirty)\t' "$MANIFEST" || echo "(no main/dirty refs found)"

echo
echo "=================================================================="
echo " MANIFEST SHA256:  $MAN_SHA"
echo "   ^ portable fingerprint — must match: source == copy == after"
echo " files:  $MANIFEST"
echo "         $FSCK_OUT"
echo "         $LOG"
echo "=================================================================="
