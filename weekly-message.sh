#!/bin/bash
# Еженедельное сообщение в группу (четверг 19:00 МСК).
# Usage: weekly-message.sh [имя-инстанса]   (по умолчанию — первый в настройках)
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${VIBECODEX_CONFIG:-$DIR/vibecodex.yaml}"
INSTANCE="${1:-}"

if [ ! -f "$CONFIG" ]; then
    echo "ERROR: нет файла настроек $CONFIG" >&2
    exit 1
fi

# Токен берётся из того же файла, что читает бот: второго места для секретов нет.
TOKEN=$(CONFIG="$CONFIG" INSTANCE="$INSTANCE" python3 - <<'PY'
import os, sys, re
raw = open(os.environ["CONFIG"], encoding="utf-8").read()
want = os.environ.get("INSTANCE") or ""
current, token = None, None
for line in raw.splitlines():
    m = re.match(r'^  ([A-Za-z0-9_-]+):\s*$', line)
    if m:
        current = m.group(1)
        continue
    m = re.search(r'^\s*token:\s*"([^"]+)"', line)
    if m and (not want or current == want) and token is None:
        token = m.group(1)
sys.stdout.write(token or "")
PY
)

if [ -z "$TOKEN" ]; then
    echo "ERROR: в $CONFIG не нашёлся токен${INSTANCE:+ для инстанса $INSTANCE}" >&2
    exit 1
fi

CHAT_ID="-5107699938"
TEXT="чекак 🐽?"

curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    -d "text=${TEXT}" \
    > /dev/null 2>&1

echo "Message sent at $(date)"
