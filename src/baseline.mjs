// Deterministic Minesweeper policies with no model in the loop.
// Used as a baseline to score Jev against, and as Jev's own fallback.

import {
	adjacentMineCount,
	cellKey,
	hiddenCells,
	inBounds,
	isFlagged,
	isHidden,
	isRevealed,
	neighbors,
	remainingMines,
} from './engine.mjs'

function parse(key) {
	const [x, y] = key.split(',').map(Number)
	return { x, y }
}

function byPosition(a, b) {
	return a.y - b.y || a.x - b.x
}

/** Cells that local constraints prove safe, and cells they prove are mines. */
export function analyze(game) {
	const safe = new Set()
	const mines = new Set()
	for (const key of game.revealed) {
		const { x, y } = parse(key)
		const number = adjacentMineCount(game, x, y)
		if (number === 0) continue
		let flagged = 0
		const hidden = []
		for (const [nx, ny] of neighbors(x, y)) {
			if (!inBounds(game, nx, ny)) continue
			if (isFlagged(game, nx, ny)) flagged += 1
			else if (isHidden(game, nx, ny)) hidden.push({ x: nx, y: ny })
		}
		if (hidden.length === 0) continue
		if (flagged === number) for (const cell of hidden) safe.add(cellKey(cell.x, cell.y))
		else if (number - flagged === hidden.length) for (const cell of hidden) mines.add(cellKey(cell.x, cell.y))
	}
	for (const key of mines) safe.delete(key)
	return { safe: [...safe].map(parse).sort(byPosition), mines: [...mines].map(parse).sort(byPosition) }
}

/** Rough local risk: average unresolved pressure from adjacent revealed numbers. */
function localRisk(game, x, y) {
	let risk = 0
	for (const [nx, ny] of neighbors(x, y)) {
		if (!inBounds(game, nx, ny) || !isRevealed(game, nx, ny)) continue
		const number = adjacentMineCount(game, nx, ny)
		if (number === 0) continue
		let flagged = 0
		let hidden = 0
		for (const [ax, ay] of neighbors(nx, ny)) {
			if (!inBounds(game, ax, ay)) continue
			if (isFlagged(game, ax, ay)) flagged += 1
			else if (isHidden(game, ax, ay)) hidden += 1
		}
		if (hidden > 0) risk += (number - flagged) / hidden
	}
	return risk
}

function lowestRiskGuess(game) {
	const hidden = hiddenCells(game)
	if (hidden.length === 0) return null
	return hidden.sort((a, b) => localRisk(game, a.x, a.y) - localRisk(game, b.x, b.y) || a.y - b.y || a.x - b.x)[0]
}

/** A move that local constraints prove, or null when only a guess is possible. */
export function solverOnlyMove(game) {
	const { safe, mines } = analyze(game)
	if (safe.length > 0) {
		return { action: 'reveal', ...safe[0], gate: 'solver', reason: 'Local constraint proves the cell is safe.' }
	}
	if (mines.length > 0 && remainingMines(game) > 0) {
		return { action: 'flag', ...mines[0], gate: 'solver', reason: 'Local constraint proves the cell is a mine.' }
	}
	return null
}

export function baselineMove(game) {
	const proven = solverOnlyMove(game)
	if (proven) return { ...proven, gate: 'baseline' }
	const guess = lowestRiskGuess(game)
	if (!guess) return null
	return { action: 'reveal', ...guess, gate: 'baseline', reason: 'No forced move; revealing the lowest-risk cell.' }
}

export function randomMove(game, rng) {
	const hidden = hiddenCells(game)
	if (hidden.length === 0) return null
	const pick = hidden[Math.floor(rng() * hidden.length)]
	return { action: 'reveal', x: pick.x, y: pick.y, gate: 'random', reason: 'Random reveal.' }
}
