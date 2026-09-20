#!/bin/bash
# Еженедельное сообщение в группу (четверг 19:00 МСК)

# Загружаем токен из .env
ENV_FILE="$(dirname "$0")/.env"
if [ -f "$ENV_FILE" ]; then
    TELEGRAM_BOT_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d'=' -f2-)
fi

if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
    echo "ERROR: TELEGRAM_BOT_TOKEN not found"
    exit 1
fi

CHAT_ID="-5107699938"
TEXT="чекак 🐽?"

curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    -d "text=${TEXT}" \
    > /dev/null 2>&1

echo "Message sent at $(date)"
