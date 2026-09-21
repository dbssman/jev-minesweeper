#!/usr/bin/env node
// Prompt ablation. Does giving Jev Minesweeper rules and the local constraint
// counts let it classify cells correctly, versus a bare board + question?
//
//   node ablate.mjs --games 6
//
// Ground truth is the mine map. Cells the local constraints *prove* are the ones
// a reasoning player should always get right; uncertain cells are genuine guesses.

import { createGame, ensureOpened, flag, isMine, render, reveal } from './src/engine.mjs'
import { analyze, solverOnlyMove } from './src/baseline.mjs'
import { API_URL_DEFAULT, MODEL_DEFAULT, buildMineQuestions, buildMineState, callJev } from './src/jev.mjs'

/** Play only moves the constraints prove, so the board has provable cells to judge. */
function advanceWithSolver(game, maxMoves = 12) {
	for (let i = 0; i < maxMoves; i++) {
		const move = solverOnlyMove(game)
		if (!move) break
		if (move.action === 'flag') flag(game, move.x, move.y)
		else reveal(game, move.x, move.y)
	}
}

function parseArgs(argv) {
	const options = { games: 6, seed: 1, width: 9, height: 9, mines: 10 }
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--games') options.games = Number(argv[++i])
		else if (argv[i] === '--seed') options.seed = Number(argv[++i])
		else if (argv[i] === '--width') options.width = Number(argv[++i])
		else if (argv[i] === '--height') options.height = Number(argv[++i])
		else if (argv[i] === '--mines') options.mines = Number(argv[++i])
	}
	return options
}

async function evaluateVariant(label, educated, options, apiKey) {
	const stats = {
		label,
		cells: 0,
		correct: 0,
		provable: 0,
		provableCorrect: 0,
		uncertain: 0,
		uncertainCorrect: 0,
		uncertainP: 0,
	}
	for (let i = 0; i < options.games; i++) {
		const game = createGame({
			width: options.width,
			height: options.height,
			mineCount: options.mines,
			seed: options.seed + i,
		})
		ensureOpened(game)
		advanceWithSolver(game)
		const { safe, mines } = analyze(game)
		const provable = new Set([...safe, ...mines].map((c) => `${c.x},${c.y}`))
		const state = buildMineState(game, 'cautious', { educated })
		const { questions, cells } = buildMineQuestions(game, { educated })
		let result
		try {
			result = await callJev({
				apiKey,
				state,
				questions,
				model: MODEL_DEFAULT,
				apiUrl: API_URL_DEFAULT,
				timeoutMs: 20000,
			})
		} catch (error) {
			console.error(`  ${label}: call failed on seed ${options.seed + i}: ${error.message}`)
			continue
		}
		for (const { x, y } of cells) {
			const p = result.answers?.[`m_${x}_${y}`]?.noul
			if (typeof p !== 'number') continue
			const actual = isMine(game, x, y)
			const predictedMine = p >= 0.5
			stats.cells += 1
			if (predictedMine === actual) stats.correct += 1
			if (provable.has(`${x},${y}`)) {
				stats.provable += 1
				if (predictedMine === actual) stats.provableCorrect += 1
			} else {
				stats.uncertain += 1
				stats.uncertainP += p
				if (predictedMine === actual) stats.uncertainCorrect += 1
			}
		}
	}
	return stats
}

function rate(hit, total) {
	return total > 0 ? (hit / total).toFixed(2) : '  — '
}

/** The docs' recommended shape for choosing: one Choice over candidate cells. */
async function evaluateChoice(options, apiKey) {
	let boards = 0
	let boardsWithSafe = 0
	let pickedSafe = 0
	for (let i = 0; i < options.games; i++) {
		const game = createGame({
			width: options.width,
			height: options.height,
			mineCount: options.mines,
			seed: options.seed + i,
		})
		ensureOpened(game)
		advanceWithSolver(game)
		boards += 1
		const { safe } = analyze(game)
		if (safe.length === 0) continue
		boardsWithSafe += 1
		const safeSet = new Set(safe.map((c) => `${c.x},${c.y}`))
		const state = buildMineState(game, 'cautious', { educated: true })
		const { cells } = buildMineQuestions(game, { educated: true })
		const criteria = {}
		for (const { x, y } of cells) criteria[`cell_${x}_${y}`] = `column ${x}, row ${y}`
		criteria.none = 'no cell is provably safe'
		const questions = {
			safest: {
				type: 'choice',
				instructions: {
					question:
						'Which hidden cell is safest to reveal next? Prefer a cell the rules prove is safe; if none is provable, pick the least risky.',
					board: render(game),
					legend: state.legend,
					rules: state.rules,
					strategy: state.strategy,
					naiveMineProbability: state.naiveMineProbability,
				},
				criteria,
			},
		}
		try {
			const result = await callJev({
				apiKey,
				state,
				questions,
				model: MODEL_DEFAULT,
				apiUrl: API_URL_DEFAULT,
				timeoutMs: 20000,
			})
			const choice = result.answers?.safest?.choice
			if (typeof choice === 'string' && choice.startsWith('cell_')) {
				const key = choice.slice(5)
				if (safeSet.has(key)) pickedSafe += 1
			}
		} catch (error) {
			console.error(`  choice: call failed on seed ${options.seed + i}: ${error.message}`)
		}
	}
	return { boards, boardsWithSafe, pickedSafe }
}

async function main() {
	const options = parseArgs(process.argv.slice(2))
	const apiKey = process.env.TYPESAFE_API_KEY
	if (!apiKey) {
		console.error('error: TYPESAFE_API_KEY is required.')
		process.exitCode = 1
		return
	}

	const variants = [
		['compact ', { educated: false }],
		['educated', { educated: true }],
	]

	console.log(
		`\nPrompt ablation on ${options.games} boards ${options.width}x${options.height} (${options.mines} mines)\n`,
	)
	const rows = []
	for (const [label, config] of variants) {
		rows.push(await evaluateVariant(label, config.educated, options, apiKey))
	}

	console.log('variant    cells  acc@0.5  provable  prov.acc  uncertain  unc.acc  unc.avgP')
	console.log('--------------------------------------------------------------------------------')
	for (const s of rows) {
		console.log(
			`${s.label.padEnd(11)}${String(s.cells).padEnd(7)}${rate(s.correct, s.cells).padEnd(9)}${String(s.provable).padEnd(10)}${rate(s.provableCorrect, s.provable).padEnd(10)}${String(s.uncertain).padEnd(11)}${rate(s.uncertainCorrect, s.uncertain).padEnd(9)}${s.uncertain ? (s.uncertainP / s.uncertain).toFixed(2) : '—'}`,
		)
	}
	console.log('\nprovable = cells the local constraints prove (a reasoning player gets all of them)')
	console.log('uncertain = genuine guesses; acc near the base rate is expected for anyone')

	const choice = await evaluateChoice(options, apiKey)
	console.log('\nChoice probe ("which cell is safest?"):')
	console.log(`  boards with a provably-safe cell: ${choice.boardsWithSafe}/${choice.boards}`)
	console.log(
		`  picked a provably-safe cell:      ${choice.pickedSafe}/${choice.boardsWithSafe}  (${rate(choice.pickedSafe, choice.boardsWithSafe)})`,
	)
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
