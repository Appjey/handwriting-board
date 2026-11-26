# Handwriting Board & AI Agent Skill

Процедурный генератор реалистичного рукописного почерка (латиница, польские/французские диакритики, кириллица, цифры, пунктуация) в трёх форматах:
1. **AI Agent Skill** (`skills/handwriting/`) — совместим с Antigravity, Claude Code, Codex, Cursor, Gemini CLI и `skills.sh` (`npx skills add`).
2. **Автономная доска в браузере** (`dist/app.html` / `skills/handwriting/resources/board.html`) — без ИИ и без сервера, с полем ввода, слайдером «Спешка» (`0%–100%`) и экспортом прозрачного PNG (3×).
3. **Headless CLI** (`skills/handwriting/scripts/render.mjs`) — ноль внешних зависимостей, рендерит прозрачный 3× PNG или векторный SVG прямо из терминала.

---

## 1. Установка как AI SKILL

Папка [`skills/handwriting/`](skills/handwriting/) полностью автономна (скрипт `scripts/render.mjs` и доска `resources/board.html` уже собраны — `npm install` не требуется, нужен только Node.js 18+).

- **Через `skills` CLI (универсально для Claude Code / Codex / Cursor / Antigravity):**
  ```bash
  npx skills add Appjey/handwriting-board
  ```
- **Вручную — скопируй папку `skills/handwriting` в директорию скиллов нужного агента:**
  - **Antigravity (глобально):** `~/.gemini/config/skills/handwriting/` (или в проект: `.agents/skills/handwriting/`)
  - **Claude Code:** `~/.claude/skills/handwriting/`
  - **Codex:** `~/.codex/skills/handwriting/`
  - **Cursor:** `.cursor/skills/handwriting/`

После этого можно просто писать ИИ: *«напиши этот текст моим почерком на прозрачном фоне и сохрани в note.png»*.

---

## 2. Использование CLI напрямую (без ИИ)

```bash
# Прозрачный 3x PNG (обрезан по тексту, готов к вставке в Noteshelf)
node skills/handwriting/scripts/render.mjs --text "Cześć!\nMam na imię Anton." --out note.png

# Из файла с настройкой спешки (0 = аккуратно, 0.5 = обычно, 0.85 = быстро)
node skills/handwriting/scripts/render.mjs --in text.txt --out homework.png --hurry 0.55 --bg transparent

# С листом в точку или в векторный SVG
node skills/handwriting/scripts/render.mjs --in text.txt --out page.png --bg paper
node skills/handwriting/scripts/render.mjs --in text.txt --out note.svg
```

Все параметры: `node skills/handwriting/scripts/render.mjs --help`.

---

## 3. Автономная доска в браузере (без ИИ и без сервера)

Просто открой **`dist/app.html`** (или `skills/handwriting/resources/board.html`) двойным кликом в любом браузере:
- Печатай или вставляй текст в нижнее поле — сразу пишется от руки.
- Двигай **Спешка `0%`–`100%`**, **Размер**, меняй **цвет**, **ручку**, жми **🎲 Вариант** (новый `seed`) или **➕ Блок**.
- Жми **📋 Без фона** или **⬇ PNG без фона** — получаешь прозрачный PNG в 3× качестве без фона и точек.

---

## Сборка из исходников

```bash
npm install
npm run typecheck
npm run build
```

`npm run build` синхронно собирает:
- `dist/app.html` и `skills/handwriting/resources/board.html`
- `skills/handwriting/scripts/render.mjs`
- `dist/server.js` (опциональный MCP-сервер)

## Теги версий

- `v4-neat` — аккуратный старательный почерк (AR(1) инерция руки, оптический кернинг, монолиния)
- `v5-hurry` — физика беглого письма (зональное приплющивание строчных, ускоренные аллографы, сглаживание углов, ритм) + слайдер «Спешка»
- `v6-editor-export` — встроенное локальное поле ввода текста и экспорт прозрачного PNG без фона
- `v7-ai-skill` — адаптация под AI Agent Skill (`skills/handwriting/SKILL.md` + zero-dependency CLI рендерер PNG/SVG)
