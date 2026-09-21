// Everything that talks to TypeSafe's Jev, plus the code-owned policy that
// turns Jev's probabilities into a move. Server-side only.

import {
	adjacentMineCount,
	cellContext,
	hiddenCells,
	inBounds,
	isRevealed,
	neighbors,
	remainingMines,
	render,
} from './engine.mjs'

/** Cap on Noul questions per call: keeps large boards fast and cheap. */
export const MAX_QUESTIONS_PER_CALL = 120

export const MODEL_DEFAULT = 'jev-latest'
export const API_URL_DEFAULT = 'https://api.typesafe.ai/v1/systemone'
export const PRICE_PER_MILLION_INPUT_USD = 0.042

// Personas differ in both the instruction the model sees and the code thresholds
// that turn probabilities into a reveal/flag action. The thresholds are the real
// behaviour; the style line nudges the model.
export const PERSONAS = {
	cautious: {
		label: 'Cautious',
		style: 'Play cautiously. You dislike guessing: prefer flagging cells you believe are mines, and only reveal a cell when you are confident it is safe.',
		revealThreshold: 0.05,
		flagThreshold: 0.4,
	},
	bold: {
		label: 'Bold',
		style: 'Play boldly. You value progress: reveal the safest-looking cell even when some risk remains, and flag only when a cell is almost certainly a mine.',
		revealThreshold: 0.55,
		flagThreshold: 0.85,
	},
}
export function buildMineState(game, persona) {
	const profile = PERSONAS[persona] ?? PERSONAS.cautious
	const hiddenCount = hiddenCells(game).length
	const unplacedMines = Math.max(0, game.mineCount - game.flags.size)
	return {
		board: render(game),
		legend: '`board` rows are y (top to bottom), columns are x (left to right). ? = hidden, F = flagged, _ = revealed with no adjacent mines, 1-8 = revealed with that many adjacent mines.',
		width: game.width,
		height: game.height,
		mineCount: game.mineCount,
		flagsPlaced: game.flags.size,
		hiddenCount,
		// The base rate if a cell had no local information. Useful as an anchor so
		// the model does not over-estimate on an empty board.
		naiveMineProbability: hiddenCount > 0 ? Number((unplacedMines / hiddenCount).toFixed(3)) : 0,
		playingStyle: profile.style,
	}
}

/** How much a cell's neighbours constrain it (revealed numbers are informative). */
function infoScore(game, x, y) {
	let score = 0
	for (const [nx, ny] of neighbors(x, y)) {
		if (!inBounds(game, nx, ny) || !isRevealed(game, nx, ny)) continue
		score += 1
		if (adjacentMineCount(game, nx, ny) > 0) score += 2
	}
	return score
}

/** One Noul per hidden cell: P(that cell is a mine). All asked in a single call.
 * On large boards the most constrained cells are asked first, capped per call. */
export function buildMineQuestions(game, { maxQuestions = MAX_QUESTIONS_PER_CALL } = {}) {
	const hidden = hiddenCells(game)
	const cells =
		hidden.length <= maxQuestions
			? hidden
			: [...hidden]
					.sort((a, b) => infoScore(game, b.x, b.y) - infoScore(game, a.x, a.y) || a.y - b.y || a.x - b.x)
					.slice(0, maxQuestions)
	const questions = {}
	for (const { x, y } of cells) {
		questions[`m_${x}_${y}`] = {
			type: 'noul',
			instructions: {
				question: `Is the hidden cell at column ${x}, row ${y} a mine?`,
				cell: { column: x, row: y },
				neighbors: cellContext(game, x, y),
			},
			criteria: {
				true: 'The cell contains a mine.',
				false: 'The cell is safe to reveal.',
			},
		}
	}
	return { questions, cells, totalHidden: hidden.length }
}

export function composeMineMove(game, answers, cells, persona) {
	const profile = PERSONAS[persona] ?? PERSONAS.cautious
	const scored = cells
		.map(({ x, y }) => ({ x, y, p: answers?.[`m_${x}_${y}`]?.noul }))
		.filter((cell) => typeof cell.p === 'number')
	if (scored.length === 0) return null

	const sorted = [...scored].sort((a, b) => a.p - b.p)
	const safest = sorted[0]
	const mostLikelyMine = sorted[sorted.length - 1]
	const canFlag = remainingMines(game) > 0
	// Flagging is only informative when the likeliest mine is clearly riskier than
	// the safest cell. On an empty or uniform board there is no contrast, so
	// flagging would just burn flags — reveal instead.
	const contrast = mostLikelyMine.p - safest.p

	const base = {
		mineProbability: safest.p,
		trace: {
			safest: { ...safest, p: Number(safest.p.toFixed(3)) },
			mostLikelyMine: { ...mostLikelyMine, p: Number(mostLikelyMine.p.toFixed(3)) },
			contrast: Number(contrast.toFixed(3)),
		},
	}

	if (safest.p <= profile.revealThreshold) {
		return {
			action: 'reveal',
			x: safest.x,
			y: safest.y,
			gate: 'model',
			reason: `Safest cell P(mine)=${safest.p.toFixed(2)}.`,
			...base,
		}
	}
	if (canFlag && mostLikelyMine.p >= profile.flagThreshold && contrast >= 0.15) {
		return {
			action: 'flag',
			x: mostLikelyMine.x,
			y: mostLikelyMine.y,
			gate: 'model',
			reason: `Likeliest mine P(mine)=${mostLikelyMine.p.toFixed(2)}, clearly riskier than the safest cell.`,
			...base,
		}
	}
	return {
		action: 'reveal',
		x: safest.x,
		y: safest.y,
		gate: 'forced',
		reason: `No cell is confidently safe or distinct (best P(mine)=${safest.p.toFixed(2)}); revealing the safest anyway.`,
		...base,
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Call the TypeSafe System One endpoint with retries and a timeout. */
export async function callJev({
	apiKey,
	state,
	questions,
	model = MODEL_DEFAULT,
	apiUrl = API_URL_DEFAULT,
	timeoutMs = 20000,
}) {
	let lastError
	for (let attempt = 0; attempt < 3; attempt++) {
		if (attempt > 0) await sleep(300 * 3 ** (attempt - 1))
		const started = performance.now()
		try {
			const response = await fetch(apiUrl, {
				method: 'POST',
				headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ model, state, questions }),
				signal: AbortSignal.timeout(timeoutMs),
			})
			const latencyMs = Math.round(performance.now() - started)
			if (response.status === 429 || response.status === 529 || response.status >= 500) {
				lastError = new Error(`TypeSafe ${response.status}`)
				continue
			}
			const payload = await response.json().catch(() => ({}))
			if (!response.ok) {
				const detail =
					payload?.detail?.message ??
					payload?.error?.message ??
					payload?.message ??
					JSON.stringify(payload).slice(0, 300)
				const error = new Error(`TypeSafe ${response.status}: ${detail}`)
				error.fatal = true
				throw error
			}
			return {
				answers: payload?.answers ?? {},
				model: payload?.model ?? model,
				usage: payload?.usage ?? {},
				latencyMs,
			}
		} catch (error) {
			if (error?.fatal) throw error
			lastError = error
		}
	}
	throw lastError ?? new Error('TypeSafe request failed')
}

/** Bin prediction/outcome pairs into a reliability table. */
export function calibrationBins(samples, binCount = 10) {
	const bins = Array.from({ length: binCount }, (_, index) => ({
		label: `${(index / binCount).toFixed(1)}-${((index + 1) / binCount).toFixed(1)}`,
		low: index / binCount,
		count: 0,
		predictedSum: 0,
		actualSum: 0,
	}))
	for (const sample of samples) {
		const index = Math.min(binCount - 1, Math.max(0, Math.floor(sample.p * binCount)))
		const bin = bins[index]
		bin.count += 1
		bin.predictedSum += sample.p
		bin.actualSum += sample.actual ? 1 : 0
	}
	return bins.map((bin) => ({
		label: bin.label,
		count: bin.count,
		avgPredicted: bin.count ? bin.predictedSum / bin.count : null,
		actualRate: bin.count ? bin.actualSum / bin.count : null,
	}))
}

export function formatCalibration(samples) {
	const bins = calibrationBins(samples)
	const lines = ['bin        n     predicted   actual', '------------------------------------------']
	for (const bin of bins) {
		if (bin.count === 0) continue
		lines.push(
			`${bin.label.padEnd(11)}${String(bin.count).padEnd(6)}${bin.avgPredicted.toFixed(2).padEnd(12)}${bin.actualRate.toFixed(2)}`,
		)
	}
	return lines.join('\n')
}
