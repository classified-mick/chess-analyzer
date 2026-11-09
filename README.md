# Chess Review

A local, chess.com-style game review that runs on your own computer with a full-strength
**Stockfish** engine. The interface is in Russian.

- Load a game from a **chess.com** or **lichess** link, paste a **PGN**, or pick from a chess.com player's recent games.
- Every move gets a class like on chess.com: brilliant, great, best, excellent, good, book,
  inaccuracy, mistake, miss, blunder. Player accuracy uses the lichess formula.
- **Explanations** for each move: what it does (fork, pin, check, hanging piece, mate threat,
  development…), why a bad move is bad (the opponent's best reply and what it wins),
  and which move was better and what its idea is.
- **Play your own moves** at any point of the review: drag a piece and the engine evaluates the new
  position and grades your move. Clicking a move in an engine line plays it too.
- **Live analysis** of the current position: 3 engine lines, best-move arrow, "threat" button.
- **Retry** mode on mistakes: try to find a better move yourself.
- **Report**: accuracy, move-class counts, opening name, key moments.

## Requirements

- macOS or Linux with [Node.js](https://nodejs.org) 20+
- Stockfish: `brew install stockfish` (or set `STOCKFISH_PATH`)

## Start and stop

On a Mac, double-click **`Start Chess.command`** in the project folder. It installs dependencies
on first run, starts the app in the background and opens http://localhost:5180.

To stop it, use any of:
- the **⏻** button in the top-right corner of the app,
- double-click **`Stop Chess.command`**,
- `npm run stop`.

It also shuts itself down 10 minutes after the last tab is closed, so the engine never keeps running
forgotten in the background.

From a terminal:

```bash
npm run up      # start in the background
npm run stop    # stop
npm run status  # is it running?
npm start       # run in the foreground (Ctrl+C to stop)
```

## CPU usage

The **Тихо / Обычно / Максимум** switch in the header sets how hard Stockfish works:

| Mode | Cores used | Live analysis per position |
|---|---|---|
| Тихо (quiet) | 1 | up to 6 s, depth 20 |
| Обычно (normal) | 2 | up to 15 s, depth 24 |
| Максимум (max) | up to 4 (review: all but 2) | up to 60 s, depth 40 |

When the search is done, or the tab is hidden, the engine stops and uses no CPU.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `5180` | Port of the local server |
| `STOCKFISH_PATH` | `stockfish` | Path to the engine binary |
| `POWER` | `normal` | Starting mode: `quiet`, `normal`, `max` |
| `IDLE_EXIT_MIN` | `10` | Minutes without an open tab before auto shutdown (`0` = never) |
| `NO_OPEN` | | Set to `1` to not open the browser on start |

## How it works

- `server/index.js` – HTTP + WebSocket server. Runs two Stockfish processes: one reviews the whole game,
  the other analyses the position on the board.
- `server/engine.js` – small UCI wrapper.
- `server/sources.js` – chess.com and lichess import.
- `src/lib/review.js` – move classification and accuracy.
- `src/lib/explain.js` – plain-language move explanations (rule-based, no network).
- `src/main.js` – UI ([chessground](https://github.com/lichess-org/chessground) board, [chess.js](https://github.com/jhlywa/chess.js)).
- `scripts/build-openings.js` – rebuilds the opening book from [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) (CC0).
- `scripts/selftest.js` – reviews the sample game in the terminal: `npm test`.

Review results are cached in `data/cache/`, so reopening a game is instant.

For development: `npm run serve` (server) and `npm run dev` (Vite with hot reload on http://localhost:5173).

## License

GPL-3.0-or-later (the board library, chessground, is GPL-3.0). Copyright © 2026 Mykhailo Kholiev.
