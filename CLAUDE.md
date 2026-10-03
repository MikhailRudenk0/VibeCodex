# VibeIDE

Telegram-бот, дающий доступ к полному Claude Code агенту с телефона.
Апстрим: https://github.com/junecv/vibeIDE. Это рабочая локальная установка.

Через этого бота пользователь и общается со мной — правила языка и форматирования ответов
лежат в глобальном `~/.claude/CLAUDE.md`, здесь не дублируются.

## Ключевые особенности

- Grammy (Node.js) + Claude Agent SDK, запуск через `tsx` без сборки.
- Стриминг ответов в Telegram с throttle ~300 мс.
- Автоматическое разбиение длинных сообщений (~3800 символов; лимит Telegram — 4096).
- Автоматический resume сессий Claude.
- Поддержка изображений (vision).
- Распознавание голосовых сообщений (whisper.cpp) + показ распознанного текста пользователю (🎤).
- Команды: `/projects`, `/switch`, `/new`, `/status`.

## Структура

```
/home/myuser/vibeide/
  app/src/
    index.ts       — точка входа, парсинг CLI, запуск
    config.ts      — загрузка env-файла (TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID)
    bot.ts         — Grammy бот, все handlers и команды, транскрипция голоса
    bridge.ts      — обёртка Claude Agent SDK, управление сессиями
    streamer.ts    — потоковая передача ответов в Telegram с throttling
    projects.ts    — обнаружение проектов из ~/.claude/projects/
  bin/
    transcribe.sh  — транскрипция голоса через whisper.cpp
    whisper-cli, ffmpeg, ffprobe — бинарники для неё
  run-bot.sh       — универсальный keepalive-wrapper: run-bot.sh <name> [projects_dir]
  restart.sh       — остановка и запуск инстансов (см. ниже)
  run-vibeide.sh   — ЛЕГАСИ wrapper только для main; оставлен для совместимости, не использовать
  .env.<name>      — токен и user ID на каждый инстанс
  vibeide-<name>.log — лог инстанса
```

## Инстансы

Запущено два бота, каждый со своим токеном и своей директорией проектов:

| name     | env-файл      | директория проектов               |
|----------|---------------|-----------------------------------|
| `main`   | `.env.main`   | `/home/myuser/vibeide-projects`   |
| `second` | `.env.second` | `/home/myuser/projects/ContentAgent` |

Оба поднимаются из crontab по `@reboot`. На каждый инстанс — свой `flock`
(`.vibeide-<name>.lock`), чтобы один токен никогда не опрашивали два процесса
(иначе Telegram отдаёт 409).

## Как обновлять и перезапускать

После изменения файлов в `app/src/` нужен перезапуск — сборки нет, `tsx` читает исходники при старте.

```bash
/home/myuser/vibeide/restart.sh           # все инстансы
/home/myuser/vibeide/restart.sh main      # только main
/home/myuser/vibeide/restart.sh second    # только second
```

`restart.sh` сам убивает process group wrapper'а, чистит lock-файл, стартует заново через
`setsid` и в конце печатает список живых процессов — проверять результат по этому выводу.

Если перезапускаешь вручную: убивать только node-процесс (`node ... tsx app/src/index.ts`),
wrapper поднимет его заново через 5 секунд. НЕ убивать bash-процесс `run-bot.sh` — это
keepalive-wrapper, он должен работать всегда.

Важно: перезапуск инстанса, через который идёт текущий диалог, обрывает собственную сессию —
сначала доводи ответ до конца, перезапускай последним действием.
