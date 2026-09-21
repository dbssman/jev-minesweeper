// Everything that talks to TypeSafe's Jev, plus the code-owned policy that
// turns Jev's probabilities into a move. Server-side only.

import {
	adjacentMineCount,
	hiddenCells,
	inBounds,
	isFlagged,
	isHidden,
	isRevealed,
	neighbors,
	remainingMines,
	render,
} from './engine.mjs'

/** Cap on Noul questions per call: keeps large boards fast and cheap. */
export const MAX_QUESTIONS_PER_CALL = 60

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
const RULES =
	'Minesweeper rules: every revealed number N counts the N mines among its up-to-8 neighbours. A hidden cell is PROVABLY SAFE if some adjacent revealed number N already has N flagged neighbours. A hidden cell is PROVABLY A MINE if some adjacent revealed number N has (hidden neighbours + flagged neighbours) = N and (N - flagged neighbours) is exactly the number of hidden neighbours. Otherwise the cell is UNCERTAIN and must be estimated.'

const STRATEGY =
	'Strategy: first look for a provably safe cell and reveal it; if none, flag a provably-mine cell; only guess when nothing is provable, and then prefer the hidden cell next to the smallest numbers. Each question includes `local_constraints` giving, for every revealed number adjacent to the cell, its number and how many of its neighbours are flagged or hidden — use those counts instead of counting yourself.'

export function buildMineState(game, persona, { educated = true } = {}) {
	const profile = PERSONAS[persona] ?? PERSONAS.cautious
	const hiddenCount = hiddenCells(game).length
	const unplacedMines = Math.max(0, game.mineCount - game.flags.size)
	const state = {
		board: render(game),
		legend: '`board` rows are y (top to bottom), columns are x (left to right). ? = hidden, F = flagged, _ = revealed with no adjacent mines, 1-8 = revealed with that many adjacent mines.',
		width: game.width,
		height: game.height,
		mineCount: game.mineCount,
		flagsPlaced: game.flags.size,
		hiddenCount,
		// The base rate if a cell had no local information, so the model does not
		// over-estimate on an empty board.
		naiveMineProbability: hiddenCount > 0 ? Number((unplacedMines / hiddenCount).toFixed(3)) : 0,
		playingStyle: profile.style,
	}
	if (educated) {
		state.rules = RULES
		state.strategy = STRATEGY
	}
	return state
}

/** For each revealed number next to (x,y): the number and its flagged/hidden neighbour counts. */
function localConstraints(game, x, y) {
	const constraints = []
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
		constraints.push({ number_at: [nx, ny], number, flagged_neighbours: flagged, hidden_neighbours: hidden })
	}
	return constraints
}
/** Hidden cells that touch at least one revealed cell: where probabilities are informative. */
export function frontierCells(game) {
	return hiddenCells(game).filter(({ x, y }) =>
		neighbors(x, y).some(([nx, ny]) => inBounds(game, nx, ny) && isRevealed(game, nx, ny)),
	)
}

/** One short Noul per queryable cell: P(that cell is a mine), all in a single call.
 * The board (with its numbers) lives in the shared state, so each question is a
 * one-line string rather than a repeated neighbour array. */
export function buildMineQuestions(
	game,
	{ maxQuestions = MAX_QUESTIONS_PER_CALL, minQuestions = 12, educated = true } = {},
) {
	const hidden = hiddenCells(game)
	const frontier = frontierCells(game)
	const frontierKeys = new Set(frontier.map((c) => `${c.x},${c.y}`))
	const interior = hidden.filter((c) => !frontierKeys.has(`${c.x},${c.y}`))
	// Frontier cells are where the numbers constrain an answer; interior cells are
	// base-rate, added only to keep a floor of options on a sparse board.
	const pool = frontier.length >= minQuestions ? frontier : [...frontier, ...interior]
	const cells = pool.slice(0, maxQuestions)
	const questions = {}
	for (const { x, y } of cells) {
		questions[`m_${x}_${y}`] = {
			type: 'noul',
			instructions: educated
				? {
						question: `Is the hidden cell at column ${x}, row ${y} a mine? Apply the rules and strategy to its \`local_constraints\`.`,
						local_constraints: localConstraints(game, x, y),
					}
				: `In \`board\`, is the hidden cell at column ${x}, row ${y} a mine? Use the revealed numbers around it.`,
		}
	}
	return { questions, cells, totalHidden: hidden.length, frontier: frontier.length }
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
			if (response.status === 429 || response.status === 529 || response.status >= 500) {
				lastError = new Error(`TypeSafe ${response.status}`)
				continue
			}
			const payload = await response.json().catch(() => ({}))
			// Measured after the body is read, so it reflects the real round-trip.
			const latencyMs = Math.round(performance.now() - started)
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
