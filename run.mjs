#!/usr/bin/env node
// Headless evaluation harness.
//
//   node run.mjs --games 8 --policy jev:cautious --policy jev:bold --policy baseline
//
// Plays N seeded boards with each policy, prints solve rate and (for the Jev
// policies) a reliability table for P(mine), and writes a JSON report.

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { createGame, flag, isMine, reveal, serialize } from './src/engine.mjs'
import { baselineMove, randomMove, solverOnlyMove } from './src/baseline.mjs'
import {
	API_URL_DEFAULT,
	MODEL_DEFAULT,
	PERSONAS,
	buildMineQuestions,
	buildMineState,
	callJev,
	composeMineMove,
	formatCalibration,
} from './src/jev.mjs'

function parseArgs(argv) {
	const options = {
		games: 5,
		seed: 1000,
		width: 9,
		height: 9,
		mines: 10,
		concurrency: 4,
		policies: [],
		out: null,
		model: MODEL_DEFAULT,
	}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === '--games') options.games = Number(argv[++i])
		else if (arg === '--seed') options.seed = Number(argv[++i])
		else if (arg === '--width') options.width = Number(argv[++i])
		else if (arg === '--height') options.height = Number(argv[++i])
		else if (arg === '--mines') options.mines = Number(argv[++i])
		else if (arg === '--concurrency') options.concurrency = Number(argv[++i])
		else if (arg === '--model') options.model = argv[++i]
		else if (arg === '--out') options.out = argv[++i]
		else if (arg === '--policy') options.policies.push(argv[++i])
		else if (arg === '--help' || arg === '-h') options.help = true
	}
	if (options.policies.length === 0) options.policies = ['jev:cautious', 'jev:bold', 'baseline']
	return options
}

function mulberry32(seed) {
	let state = seed >>> 0
	return function next() {
		state |= 0
		state = (state + 0x6d2b79f5) | 0
		let t = Math.imul(state ^ (state >>> 15), 1 | state)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

function isJev(policy) {
	return policy.startsWith('jev:')
}

function policyParts(policy) {
	return policy.split(':')
}

function personaOf(policy) {
	const persona = policyParts(policy)[1]
	return Object.hasOwn(PERSONAS, persona) ? persona : 'cautious'
}

/** `jev:cautious:pure` skips the deterministic solver and lets Jev guess every move. */
function isPure(policy) {
	return policyParts(policy).includes('pure')
}

async function playSeed(policy, seed, options, apiKey) {
	const game = createGame({ width: options.width, height: options.height, mineCount: options.mines, seed })
	const rng = mulberry32(seed * 7919 + 13)
	const calibration = []
	const maxMoves = options.width * options.height * 4
	let moves = 0
	let jevCalls = 0

	while (!game.lost && !game.won && moves < maxMoves) {
		let decision = null
		if (policy === 'baseline') {
			decision = baselineMove(game)
		} else if (policy === 'random') {
			decision = randomMove(game, rng)
		} else if (isJev(policy)) {
			const persona = personaOf(policy)
			const state = buildMineState(game, persona)
			const { questions, cells } = buildMineQuestions(game)
			try {
				const result = await callJev({
					apiKey,
					state,
					questions,
					model: options.model,
					apiUrl: options.apiUrl ?? API_URL_DEFAULT,
					timeoutMs: options.timeoutMs ?? 20000,
				})
				jevCalls += 1
				for (const { x, y } of cells) {
					const p = result.answers?.[`m_${x}_${y}`]?.noul
					if (typeof p === 'number') calibration.push({ p, actual: isMine(game, x, y) })
				}
				const composed = composeMineMove(game, result.answers, cells, persona) ?? baselineMove(game)
				const proven = isPure(policy) ? null : solverOnlyMove(game)
				decision = proven ?? composed
			} catch (error) {
				decision = baselineMove(game)
				decision = decision ? { ...decision, gate: 'fallback', reason: `Jev failed: ${error.message}` } : null
			}
		}
		if (!decision) break

		if (decision.action === 'flag') {
			flag(game, decision.x, decision.y)
		} else if (!reveal(game, decision.x, decision.y).ok) {
			const fallback = baselineMove(game)
			if (fallback) {
				if (fallback.action === 'flag') flag(game, fallback.x, fallback.y)
				else reveal(game, fallback.x, fallback.y)
			}
		}
		moves += 1
	}

	return { policy, seed, won: game.won, lost: game.lost, moves, jevCalls, calibration, state: serialize(game) }
}

async function runPool(tasks, concurrency, worker) {
	const results = []
	let index = 0
	async function next() {
		while (index < tasks.length) {
			const current = index++
			results[current] = await worker(tasks[current])
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, next))
	return results
}

async function main() {
	const options = parseArgs(process.argv.slice(2))
	if (options.help) {
		console.log(
			[
				'Usage: node run.mjs [options]',
				'  --policy <jev:cautious|jev:bold|baseline|random>   repeatable',
				'  --games <n>        boards per policy (default 5)',
				'  --seed <n>         base seed; each game uses seed + index (default 1000)',
				'  --width/--height/--mines   board size (default 9/9/10)',
				'  --concurrency <n>  parallel games (default 4)',
				'  --model <id>       TypeSafe model (default jev-latest)',
				'  --out <path>       JSON report path',
			].join('\n'),
		)
		return
	}

	const apiKey = process.env.TYPESAFE_API_KEY
	const needsKey = options.policies.some(isJev)
	if (needsKey && !apiKey) {
		console.error('error: TYPESAFE_API_KEY is required for jev:* policies (set it in the environment).')
		process.exitCode = 1
		return
	}

	const tasks = []
	for (const policy of options.policies) {
		for (let i = 0; i < options.games; i++) tasks.push({ policy, seed: options.seed + i })
	}

	console.log(
		`\nPlaying ${options.games} boards x ${options.policies.length} policies on ${options.width}x${options.height} (${options.mines} mines)...\n`,
	)
	const started = Date.now()
	const results = await runPool(tasks, options.concurrency, (task) =>
		playSeed(task.policy, task.seed, options, apiKey),
	)
	const elapsedSeconds = ((Date.now() - started) / 1000).toFixed(1)

	const byPolicy = new Map()
	for (const result of results) {
		if (!byPolicy.has(result.policy)) byPolicy.set(result.policy, [])
		byPolicy.get(result.policy).push(result)
	}

	console.log('policy                 games   solved   rate    avg moves   jev calls')
	console.log('---------------------------------------------------------------------')
	for (const [policy, list] of byPolicy) {
		const solved = list.filter((r) => r.won).length
		const avgMoves = (list.reduce((sum, r) => sum + r.moves, 0) / list.length).toFixed(1)
		const calls = list.reduce((sum, r) => sum + r.jevCalls, 0)
		console.log(
			`${policy.padEnd(23)}${String(list.length).padEnd(8)}${String(solved).padEnd(9)}${(solved / list.length).toFixed(2).padEnd(8)}${avgMoves.padEnd(12)}${calls}`,
		)
	}

	const jevResults = results.filter((r) => isJev(r.policy))
	const samples = jevResults.flatMap((r) => r.calibration)
	if (samples.length > 0) {
		console.log('\nCalibration of P(mine) over all Jev Noul answers:')
		console.log(formatCalibration(samples))
	}

	console.log(`\nDone in ${elapsedSeconds}s.`)

	const report = {
		options,
		generatedAt: new Date().toISOString(),
		summary: [...byPolicy].map(([policy, list]) => ({
			policy,
			games: list.length,
			solved: list.filter((r) => r.won).length,
			avgMoves: list.reduce((sum, r) => sum + r.moves, 0) / list.length,
			jevCalls: list.reduce((sum, r) => sum + r.jevCalls, 0),
		})),
		calibration: samples.length > 0 ? samples.length : 0,
		results,
	}
	const outPath = options.out ?? path.join('reports', `minesweeper-${Date.now()}.json`)
	mkdirSync(path.dirname(outPath), { recursive: true })
	writeFileSync(outPath, JSON.stringify(report, null, 2))
	console.log(`Report written to ${outPath}`)
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
