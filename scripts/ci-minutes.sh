#!/usr/bin/env bash
# Actions minutes report (October 19, 2026): today's and this month's minutes by PR, the pace
# against what's included plus the budget, and which pushes or PRs to batch. Runs on this Mac
# (free); never as a workflow, which would spend the minutes it counts.
# Usage: scripts/ci-minutes.sh [--notify]   (--notify: a macOS notification when over)
set -euo pipefail
REPO=qashsolutions/myfinapp
INCLUDED=${INCLUDED:-2000}        # 3000 with GitHub Pro (from October 22, 2026)
BUDGET_USD=${BUDGET_USD:-5}         # owner, October 19, 2026
PER_MIN=${PER_MIN:-0.0067}           # $0.006 a Linux minute, plus ~12% this count misses (GitHub showed $0.88 when it said $0.79, October 19, 2026)
DAILY_WARN=${DAILY_WARN:-50}      # $5 stretched over the rest of October ≈ 50 minutes a day (owner, October 19, 2026)
PRIVATE_SINCE=${PRIVATE_SINCE:-2026-10-16}   # public before this: those minutes were free
# The included minutes ran out on October 19, 2026; runs created after this are paid from the budget.
PAID_SINCE=${PAID_SINCE:-2026-10-19T19:20:00Z}
STATE=${XDG_CACHE_HOME:-$HOME/.cache}/qash-ci-budget-alerts   # thresholds already alerted, per month
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/qash-ci-minutes.tsv
mkdir -p "$(dirname "$CACHE")"; touch "$CACHE"
month=$(date +%Y-%m-01); today=$(date +%Y-%m-%d)   # local days; run times converted below
day_of_month=$(date +%-d); days_in_month=$(date -v1d -v+1m -v-1d +%-d)

# Completed runs this month: id, day, workflow, PR number (or the branch), event.
runs=$(gh api --paginate "repos/$REPO/actions/runs?per_page=100&created=>=$month" --jq \
  '.workflow_runs[] | select(.status=="completed") |
   [.id, (.created_at | fromdateiso8601 | strflocaltime("%Y-%m-%d")), .name, ((.pull_requests[0].number // null) | if . then "#\(.)" else null end) // .head_branch, .event, .created_at] | @tsv')

# Billed minutes per run: each job rounds up to a whole minute. Finished runs never change, so cache them.
while IFS=$'\t' read -r id _ _ _ _; do
  [ -z "$id" ] && continue
  grep -q "^$id"$'\t' "$CACHE" && continue
  mins=$(gh api --paginate "repos/$REPO/actions/runs/$id/jobs?per_page=100" --jq \
    '.jobs[] | select(.started_at and .completed_at and .conclusion != "skipped") |
     ((.completed_at | fromdateiso8601) - (.started_at | fromdateiso8601))' |
    awk '{ m += ($1 > 0 ? int(($1 + 59) / 60) : 0) } END { print m + 0 }')
  printf '%s\t%s\n' "$id" "$mins" >> "$CACHE"
done <<< "$runs"

report=$(awk -F'\t' -v today="$today" -v inc="$INCLUDED" -v usd="$BUDGET_USD" -v pm="$PER_MIN" \
  -v dom="$day_of_month" -v dim="$days_in_month" -v warn="$DAILY_WARN" -v since="$PRIVATE_SINCE" -v paid_since="$PAID_SINCE" -v ym="${month:0:7}" '
  NR == FNR { m[$1] = $2; next }
  $1 != "" {
    mins = m[$1] + 0; if ($2 >= since) month += mins
    if (substr(paid_since, 1, 7) == ym && $6 >= paid_since) paid += mins
    if ($2 == today) { day += mins; who[$4] += mins; pushes[$4 "\t" $3]++ }
  }
  END {
    cap = inc + int(usd / pm)
    split(since, s, "-"); start = (s[2] == substr(today, 6, 2)) ? s[3] + 0 : 1; days = dom - start + 1
    pace = int(month / days * (dim - start + 1))
    printf "Today %d min (warn at %d) · month %d of %d included + $%d budget (≈%d min)\n", day, warn, month, inc, usd, cap
    printf "Month pace ≈ %d min", pace
    if (substr(paid_since, 1, 7) != ym) paid = (month > inc) ? month - inc : 0
    spent = paid * pm
    printf "\nBudget: ≈$%.2f of $%d spent (%d%%)\n", spent, usd, int(spent / usd * 100)
    printf "BUDGET_PCT=%d\n", int(spent / usd * 100)
    if (day > 0) { print "Today by PR / branch:"; for (k in who) printf "  %-28s %d min\n", k, who[k] }
    for (k in pushes) if (pushes[k] > 2) { split(k, p, "\t"); printf "  ! %s ran %s %d times today: batch fixes into one push\n", p[1], p[2], pushes[k] }
    if (day > warn) print "ALERT: over today'\''s limit; hold pushes until tomorrow"
    if (pace > cap) print "ALERT: on pace to pass the budget; batch PRs and push less"
  }' "$CACHE" <(printf '%s\n' "$runs"))
pct=$(sed -n 's/^BUDGET_PCT=//p' <<< "$report"); report=$(grep -v '^BUDGET_PCT=' <<< "$report")
# 25% and 50% of the budget: one alert each per month (GitHub's own budget emails cover the rest).
touch "$STATE"; ym=${month:0:7}
for t in 25 50; do
  if [ "$pct" -ge "$t" ] && ! grep -qx "$ym $t" "$STATE"; then
    report="ALERT: $t% of the \$$BUDGET_USD Actions budget used (≈$pct%); merge in batches only
$report"
    echo "$ym $t" >> "$STATE"; force_notify=1
  fi
done
echo "$report"

# Open PRs that are small enough to ride with another one.
small=$(gh pr list -R "$REPO" --state open --json number,title,additions,deletions --jq \
  '.[] | select(.additions + .deletions < 80) | "  #\(.number) \(.title) (\(.additions + .deletions) lines)"')
if [ -n "$small" ]; then echo "Small open PRs (fold into the next PR or merge together):"; echo "$small"; fi

if [ "${1:-}" = "--notify" ] || [ -n "${force_notify:-}" ]; then
  # Always a summary; an alert, when there is one, replaces it. Full report in the log.
  msg=$(grep '^ALERT' <<< "$report" | head -1 || true); [ -z "$msg" ] && msg=$(head -1 <<< "$report")
  title="Qash CI minutes"; grep -q '^ALERT' <<< "$report" && title="Qash CI minutes: hold pushes"
  osascript -e "display notification \"${msg//\"/}\" with title \"$title\""
fi
