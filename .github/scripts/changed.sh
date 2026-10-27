#!/usr/bin/env bash
# Which parts of the repository a run touches, so a workflow runs only the jobs that matter
# (owner, October 19, 2026: GitHub Actions minutes are limited; aim for half the usage).
#
#   changed.sh name='regex' ...   →   name=true|false lines in $GITHUB_OUTPUT
#
# A pull request compares with its base; a push to main with the commit before it. A scheduled
# or hand-started run, a new branch, or a base we can't read counts as "everything changed",
# so the weekly run and any doubt still run every job.
set -euo pipefail

base=""
case "${GITHUB_EVENT_NAME:-}" in
  pull_request) base="${BASE_SHA:-}" ;;
  push) base="${BEFORE_SHA:-}" ;;
esac

all=false
if [ -z "$base" ] || [ "$base" = "0000000000000000000000000000000000000000" ] \
  || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  all=true
fi

files=""
if [ "$all" = false ]; then
  files=$(git diff --name-only "$base" HEAD)
fi

out="${GITHUB_OUTPUT:-/dev/stdout}"
for pair in "$@"; do
  name="${pair%%=*}"
  regex="${pair#*=}"
  if [ "$all" = true ] || printf '%s\n' "$files" | grep -Eq "$regex"; then
    echo "$name=true" >> "$out"
  else
    echo "$name=false" >> "$out"
  fi
done

if [ "$all" = true ]; then
  echo "Comparing with: nothing (everything counts as changed)"
else
  printf 'Changed since %s:\n%s\n' "$base" "$files"
fi
