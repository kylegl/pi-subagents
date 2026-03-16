#!/usr/bin/env bash
set -euo pipefail

# Sync the current custom branch with upstream main/master.
# Usage:
#   ./sync-upstream.sh            # rebase custom onto upstream default branch
#   ./sync-upstream.sh --merge    # merge instead of rebase
#   ./sync-upstream.sh --branch custom --upstream upstream --base main

BRANCH="custom"
UPSTREAM_REMOTE="upstream"
BASE_BRANCH=""
MODE="rebase"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)
      BRANCH="$2"; shift 2 ;;
    --upstream)
      UPSTREAM_REMOTE="$2"; shift 2 ;;
    --base)
      BASE_BRANCH="$2"; shift 2 ;;
    --merge)
      MODE="merge"; shift ;;
    --rebase)
      MODE="rebase"; shift ;;
    -h|--help)
      sed -n '1,20p' "$0"
      exit 0 ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1 ;;
  esac
done

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "Run this inside a git repository." >&2
  exit 1
fi

# If no explicit upstream remote exists, fallback to origin.
if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  if git remote get-url origin >/dev/null 2>&1; then
    UPSTREAM_REMOTE="origin"
  else
    echo "No remote found. Add an upstream/origin remote first." >&2
    exit 1
  fi
fi

if [[ -z "$BASE_BRANCH" ]]; then
  if git ls-remote --heads "$UPSTREAM_REMOTE" main | grep -q .; then
    BASE_BRANCH="main"
  elif git ls-remote --heads "$UPSTREAM_REMOTE" master | grep -q .; then
    BASE_BRANCH="master"
  else
    echo "Could not detect upstream base branch (main/master). Use --base." >&2
    exit 1
  fi
fi

CURRENT_BRANCH="$(git branch --show-current)"

if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
  git checkout "$BRANCH"
fi

git fetch "$UPSTREAM_REMOTE"

if [[ "$MODE" == "merge" ]]; then
  git merge --no-ff "$UPSTREAM_REMOTE/$BASE_BRANCH"
else
  git rebase "$UPSTREAM_REMOTE/$BASE_BRANCH"
fi

echo

echo "✅ Synced '$BRANCH' with '$UPSTREAM_REMOTE/$BASE_BRANCH' using $MODE."
