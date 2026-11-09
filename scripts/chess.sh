#!/bin/bash
# Start / stop the chess review app in the background.
#   scripts/chess.sh start | stop | status
cd "$(dirname "$0")/.." || exit 1
PORT="${PORT:-5180}"
URL="http://localhost:$PORT"
running() { curl -fs "$URL/api/info" >/dev/null 2>&1; }

case "$1" in
  start)
    command -v node >/dev/null || { echo "Нужен Node.js: brew install node"; exit 1; }
    command -v "${STOCKFISH_PATH:-stockfish}" >/dev/null || { echo "Нужен Stockfish: brew install stockfish"; exit 1; }
    if running; then echo "Уже запущено: $URL"; open "$URL" 2>/dev/null; exit 0; fi
    [ -d node_modules ] || npm install --no-fund --no-audit
    if [ ! -f dist/index.html ] || [ -n "$(find src index.html -newer dist/index.html -print -quit)" ]; then
      npx vite build --logLevel warn || exit 1
    fi
    mkdir -p data
    nohup node server/index.js > data/server.log 2>&1 &
    for _ in $(seq 1 60); do running && break; sleep 0.25; done
    if running; then echo "Запущено: $URL (выключить: Stop Chess.command, npm run stop или кнопка ⏻)"; else echo "Не запустилось, смотри data/server.log"; tail -5 data/server.log; exit 1; fi
    ;;
  stop)
    if running; then curl -fs -X POST "$URL/api/shutdown" >/dev/null; echo "Выключено."; else echo "И так не запущено."; fi
    ;;
  status)
    if running; then echo "Работает: $URL"; else echo "Не запущено."; fi
    ;;
  *) echo "Использование: scripts/chess.sh start|stop|status"; exit 1 ;;
esac
