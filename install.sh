#!/usr/bin/env bash
# cross-prediction installer — symlinks the skill into ~/.claude/skills/ and
# installs Node deps. Idempotent: safe to re-run.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC="$REPO_DIR/skills/cross-prediction"
SKILL_DST="$HOME/.claude/skills/cross-prediction"

if [ ! -d "$SKILL_SRC" ]; then
  echo "ERROR: $SKILL_SRC not found. Run install.sh from inside the cloned repo." >&2
  exit 1
fi

mkdir -p "$HOME/.claude/skills"

if [ -L "$SKILL_DST" ]; then
  current="$(readlink "$SKILL_DST")"
  if [ "$current" = "$SKILL_SRC" ]; then
    echo "✓ symlink already points at $SKILL_SRC"
  else
    echo "↻ updating symlink: $SKILL_DST → $SKILL_SRC (was $current)"
    rm "$SKILL_DST"
    ln -s "$SKILL_SRC" "$SKILL_DST"
  fi
elif [ -e "$SKILL_DST" ]; then
  echo "ERROR: $SKILL_DST already exists and is NOT a symlink." >&2
  echo "  Move/back it up, then re-run install.sh." >&2
  exit 1
else
  ln -s "$SKILL_SRC" "$SKILL_DST"
  echo "✓ symlinked $SKILL_DST → $SKILL_SRC"
fi

echo "↻ installing Node deps in $SKILL_SRC ..."
( cd "$SKILL_SRC" && npm ci --silent )
echo "✓ deps installed"

if [ ! -f "$SKILL_SRC/.env" ]; then
  cat <<EOF

NEXT STEPS
  1. Create your wallet env file:
       cp $SKILL_SRC/.env.example $SKILL_SRC/.env
       chmod 600 $SKILL_SRC/.env
     Then pick ONE strategy and fill required vars:
       Strategy A: local signer env/config
       Strategy C: PIN=123456                  (CROSSx gateway; +$SKILL_SRC/.session/gateway.json)
     Always set MAX_TRADE_BILL (default 100, recommend 10 for new users).

  2. (Strategy C only) Configure the CROSSx gateway endpoints (maintainer setup):
       cd $SKILL_SRC && node scripts/_recon-gateway.mjs

  3. Try it from Claude Code:
       "list active CROSS prediction events"
       "show BILL balance"

EOF
else
  echo "✓ $SKILL_SRC/.env already present — skipping setup"
fi
