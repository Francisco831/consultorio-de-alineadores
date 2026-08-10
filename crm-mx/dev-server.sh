#!/bin/bash
# dev server del CRM (usado por .claude/launch.json)
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
cd "$(dirname "$0")"
exec npm run dev -- -p "${1:-3010}"
