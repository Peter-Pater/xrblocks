#!/usr/bin/env bash
# Run Gemini against a task with skill on or off, score the resulting diff.
#
# Usage:
#   ./evals/runners/run_gemini.sh <pr_num> {with-skill|without-skill}
#
# Requires:
#   - gemini CLI on PATH (npm i -g @google/gemini-cli)
#   - GEMINI_API_KEY env var
#   - the task already materialized via fetch_prs.py

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: run_gemini.sh <pr_num> {with-skill|without-skill}" >&2
  exit 1
fi

if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "error: GEMINI_API_KEY not set" >&2
  exit 1
fi

NUM="$1"
MODE="$2"
case "$MODE" in
  with-skill|without-skill) ;;
  *) echo "error: mode must be with-skill or without-skill" >&2; exit 1;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EVALS="$REPO_ROOT/evals"
TASK_DIR="$EVALS/tasks/$NUM"
WORKTREE="/tmp/xrblocks-eval-${NUM}-${MODE}"
RESULTS_DIR="$EVALS/results/gemini-${MODE}"
DIFF_PATH="$WORKTREE.diff"
LOG_PATH="$WORKTREE.log"

mkdir -p "$RESULTS_DIR"

if [ ! -d "$TASK_DIR" ]; then
  echo "error: task $NUM not materialized (run fetch_prs.py first)" >&2
  exit 1
fi

BASE_SHA="$(cat "$TASK_DIR/base.sha")"

# Clean any prior worktree.
if [ -d "$WORKTREE" ]; then
  git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" 2>/dev/null || rm -rf "$WORKTREE"
fi

echo "[$NUM/$MODE] setting up worktree at $BASE_SHA"
git -C "$REPO_ROOT" worktree add "$WORKTREE" "$BASE_SHA" >/dev/null

# Helpers: install/uninstall xb-* skills from the repo's skills/ dir.
install_xb_skills() {
  local installed=0
  for d in "$REPO_ROOT"/skills/xb-*; do
    [ -d "$d" ] || continue
    if gemini skills install "$d" --scope user --consent > /dev/null 2>&1; then
      installed=$((installed + 1))
    fi
  done
  echo "$installed"
}

uninstall_xb_skills() {
  local removed=0
  for d in "$REPO_ROOT"/skills/xb-*; do
    [ -d "$d" ] || continue
    local name
    name=$(basename "$d")
    if gemini skills uninstall "$name" --scope user > /dev/null 2>&1; then
      removed=$((removed + 1))
    fi
  done
  echo "$removed"
}

# Always start from a clean skill state so prior runs don't leak in.
n_removed=$(uninstall_xb_skills)
[ "$n_removed" -gt 0 ] && echo "[$NUM/$MODE] cleaned $n_removed pre-existing xb-* skills"

# Strip all in-project SKILL.md files for the skill-off run.
if [ "$MODE" = "without-skill" ]; then
  removed=0
  while IFS= read -r f; do
    rm -f "$f"
    removed=$((removed + 1))
  done < <(find "$WORKTREE" -name SKILL.md -not -path '*/node_modules/*')
  echo "[$NUM/$MODE] stripped $removed in-project SKILL.md files"
fi

# Install xb-* skills at user scope for the skill-on run + inject in-project
# SKILL.md files from current main (many task bases predate them).
if [ "$MODE" = "with-skill" ]; then
  n_installed=$(install_xb_skills)
  echo "[$NUM/$MODE] installed $n_installed xb-* skills"
  injected=0
  while IFS= read -r f; do
    target="$WORKTREE/$f"
    mkdir -p "$(dirname "$target")"
    git -C "$REPO_ROOT" show "origin/main:$f" > "$target"
    injected=$((injected + 1))
  done < <(git -C "$REPO_ROOT" ls-tree -r origin/main --name-only | grep "SKILL.md$" | grep -v -E '(node_modules|skills/xb-)')
  echo "[$NUM/$MODE] injected $injected in-project SKILL.md files"
fi

# Build the prompt: task body + a closing directive so gemini knows the goal.
PROMPT_BODY="$(cat "$TASK_DIR/prompt.md")"
FULL_PROMPT="You are working in a checkout of the xrblocks repo. Implement the following task by editing files in the current directory. Do not commit; just make the file changes.

TASK:
${PROMPT_BODY}"

echo "[$NUM/$MODE] invoking gemini (headless, --yolo)"
cd "$WORKTREE"
# Run gemini; capture full output for debugging.
if ! gemini --skip-trust --approval-mode yolo -o text -p "$FULL_PROMPT" > "$LOG_PATH" 2>&1; then
  echo "[$NUM/$MODE] gemini exited non-zero — see $LOG_PATH"
fi

# Capture the diff.
git -C "$WORKTREE" diff > "$DIFF_PATH"
LINES=$(wc -l < "$DIFF_PATH" | tr -d ' ')
echo "[$NUM/$MODE] diff: $LINES lines → $DIFF_PATH"

# Score.
cd "$REPO_ROOT"
python3 evals/score.py "$TASK_DIR" "$DIFF_PATH" > "$RESULTS_DIR/${NUM}.json"
echo "[$NUM/$MODE] scored → $RESULTS_DIR/${NUM}.json"

# Cleanup worktree, keep diff + log + result.
git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" >/dev/null

# Always uninstall xb-* skills at the end so subsequent runs (and your normal
# CLI use) aren't polluted.
n_removed=$(uninstall_xb_skills)
[ "$n_removed" -gt 0 ] && echo "[$NUM/$MODE] uninstalled $n_removed xb-* skills"

cat "$RESULTS_DIR/${NUM}.json"
