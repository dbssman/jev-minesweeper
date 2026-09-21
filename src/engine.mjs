// Pure Minesweeper engine. Shared by the browser, the server and the eval CLI.
// No randomness beyond a seeded RNG, and no network access.

const DIRECTIONS = [
	[-1, -1],
	[0, -1],
	[1, -1],
	[-1, 0],
	[1, 0],
	[-1, 1],
	[0, 1],
	[1, 1],
]

export const SIZES = {
	small: { label: 'Small', width: 9, height: 9 },
	medium: { label: 'Medium', width: 12, height: 12 },
	large: { label: 'Large', width: 16, height: 16 },
}

export const DIFFICULTIES = {
	easy: { label: 'Easy', density: 0.12 },
	medium: { label: 'Medium', density: 0.16 },
	hard: { label: 'Hard', density: 0.22 },
}

/** Mine count for a board size and difficulty, keeping room for a safe opening. */
export function minesFor(width, height, difficulty) {
	const density = DIFFICULTIES[difficulty]?.density ?? DIFFICULTIES.medium.density
	const max = Math.max(1, width * height - 9)
	return Math.max(1, Math.min(max, Math.round(width * height * density)))
}

export function cellKey(x, y) {
	return `${x},${y}`
}

function parseKey(key) {
	const [x, y] = key.split(',').map(Number)
	return { x, y }
}

export function mulberry32(seed) {
	let state = seed >>> 0
	return function next() {
		state |= 0
		state = (state + 0x6d2b79f5) | 0
		let t = Math.imul(state ^ (state >>> 15), 1 | state)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

export function createGame({ width = 9, height = 9, mineCount = 10, seed = 1 } = {}) {
	const safeWidth = Math.max(2, Math.min(40, Math.floor(Number(width) || 9)))
	const safeHeight = Math.max(2, Math.min(40, Math.floor(Number(height) || 9)))
	const maxMines = Math.max(1, safeWidth * safeHeight - 9)
	const requestedMines = Number.isFinite(Number(mineCount)) ? Math.floor(Number(mineCount)) : 10
	const safeMines = Math.max(0, Math.min(maxMines, requestedMines))
	return {
		width: safeWidth,
		height: safeHeight,
		mineCount: safeMines,
		seed,
		mines: new Set(),
		revealed: new Set(),
		flags: new Set(),
		minesPlaced: false,
		lost: false,
		won: false,
		revealCount: 0,
		rng: mulberry32(seed),
	}
}

export function inBounds(game, x, y) {
	return x >= 0 && y >= 0 && x < game.width && y < game.height
}

export function neighbors(x, y) {
	return DIRECTIONS.map(([dx, dy]) => [x + dx, y + dy])
}

export function isHidden(game, x, y) {
	const k = cellKey(x, y)
	return !game.revealed.has(k) && !game.flags.has(k)
}

export function isFlagged(game, x, y) {
	return game.flags.has(cellKey(x, y))
}

export function isRevealed(game, x, y) {
	return game.revealed.has(cellKey(x, y))
}

export function adjacentMineCount(game, x, y) {
	let count = 0
	for (const [nx, ny] of neighbors(x, y)) {
		if (game.mines.has(cellKey(nx, ny))) count += 1
	}
	return count
}

export function hiddenCells(game) {
	const cells = []
	for (let y = 0; y < game.height; y++) {
		for (let x = 0; x < game.width; x++) {
			if (isHidden(game, x, y)) cells.push({ x, y })
		}
	}
	return cells
}

export function revealedCells(game) {
	return [...game.revealed].map(parseKey)
}

function placeMines(game, safeX, safeY) {
	const safe = new Set([cellKey(safeX, safeY)])
	for (const [nx, ny] of neighbors(safeX, safeY)) {
		if (inBounds(game, nx, ny)) safe.add(cellKey(nx, ny))
	}
	const candidates = []
	for (let y = 0; y < game.height; y++) {
		for (let x = 0; x < game.width; x++) {
			if (!safe.has(cellKey(x, y))) candidates.push({ x, y })
		}
	}
	for (let i = candidates.length - 1; i > 0; i--) {
		const j = Math.floor(game.rng() * (i + 1))
		const tmp = candidates[i]
		candidates[i] = candidates[j]
		candidates[j] = tmp
	}
	const count = Math.min(game.mineCount, candidates.length)
	for (let i = 0; i < count; i++) game.mines.add(cellKey(candidates[i].x, candidates[i].y))
	game.minesPlaced = true
}

/** Reveal a cell. The first reveal is always mine-free (mines placed around it). */
export function reveal(game, x, y) {
	if (game.lost || game.won) return { ok: false, reason: 'game over' }
	if (!inBounds(game, x, y)) return { ok: false, reason: 'out of bounds' }
	if (game.flags.has(cellKey(x, y))) return { ok: false, reason: 'flagged' }
	if (game.revealed.has(cellKey(x, y))) return { ok: false, reason: 'already revealed' }
	if (!game.minesPlaced) placeMines(game, x, y)

	const hitMine = game.mines.has(cellKey(x, y))
	if (hitMine) {
		game.lost = true
		game.revealed.add(cellKey(x, y))
		return { ok: true, mine: true }
	}

	const stack = [[x, y]]
	while (stack.length > 0) {
		const [cx, cy] = stack.pop()
		const k = cellKey(cx, cy)
		if (game.revealed.has(k) || game.flags.has(k) || game.mines.has(k)) continue
		game.revealed.add(k)
		game.revealCount += 1
		if (adjacentMineCount(game, cx, cy) === 0) {
			for (const [nx, ny] of neighbors(cx, cy)) {
				if (inBounds(game, nx, ny) && !game.revealed.has(cellKey(nx, ny))) stack.push([nx, ny])
			}
		}
	}

	// Compare against mines actually placed: tiny boards can place fewer than mineCount.
	if (game.revealed.size === game.width * game.height - game.mines.size) game.won = true
	return { ok: true, mine: false }
}

/** Place mines and open the board with a guaranteed-safe centre reveal, so the
 * very first decision (and its calibration label) is made on a real board. */
export function ensureOpened(game) {
	if (game.minesPlaced) return false
	reveal(game, Math.floor(game.width / 2), Math.floor(game.height / 2))
	return true
}

export function flag(game, x, y) {
	if (game.lost || game.won) return { ok: false, reason: 'game over' }
	if (!inBounds(game, x, y)) return { ok: false, reason: 'out of bounds' }
	if (game.revealed.has(cellKey(x, y))) return { ok: false, reason: 'already revealed' }
	game.flags.add(cellKey(x, y))
	return { ok: true }
}

export function unflag(game, x, y) {
	game.flags.delete(cellKey(x, y))
	return { ok: true }
}

export function remainingMines(game) {
	return game.mineCount - game.flags.size
}

/** Neighbours of a cell, described for the model. */
export function cellContext(game, x, y) {
	const context = []
	for (const [nx, ny] of neighbors(x, y)) {
		if (!inBounds(game, nx, ny)) continue
		const k = cellKey(nx, ny)
		if (game.flags.has(k)) context.push({ column: nx, row: ny, state: 'flagged' })
		else if (game.revealed.has(k)) {
			context.push({ column: nx, row: ny, state: 'revealed', adjacentMines: adjacentMineCount(game, nx, ny) })
		} else context.push({ column: nx, row: ny, state: 'hidden' })
	}
	return context
}

export function render(game) {
	const rows = []
	for (let y = 0; y < game.height; y++) {
		let row = ''
		for (let x = 0; x < game.width; x++) {
			const k = cellKey(x, y)
			if (game.lost && game.mines.has(k)) row += '*'
			else if (game.flags.has(k)) row += 'F'
			else if (!game.revealed.has(k)) row += '?'
			else {
				const n = adjacentMineCount(game, x, y)
				row += n === 0 ? '_' : String(n)
			}
		}
		rows.push(row)
	}
	return rows.join('\n')
}

export function serialize(game) {
	return {
		width: game.width,
		height: game.height,
		mineCount: game.mineCount,
		seed: game.seed,
		minesPlaced: game.minesPlaced,
		lost: game.lost,
		won: game.won,
		revealCount: game.revealCount,
		mines: [...game.mines],
		revealed: [...game.revealed],
		flags: [...game.flags],
	}
}

/** Rebuild a game from a serialized snapshot. The RNG is not restored; it is
 * only needed when placing mines, which has already happened. */
export function deserialize(data) {
	const game = createGame({
		width: data.width,
		height: data.height,
		mineCount: data.mineCount,
		seed: data.seed,
	})
	game.mines = new Set(data.mines ?? [])
	game.revealed = new Set(data.revealed ?? [])
	game.flags = new Set(data.flags ?? [])
	game.minesPlaced = Boolean(data.minesPlaced)
	game.lost = Boolean(data.lost)
	game.won = Boolean(data.won)
	game.revealCount = data.revealCount ?? 0
	return game
}

export function isMine(game, x, y) {
	return game.mines.has(cellKey(x, y))
}
