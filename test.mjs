import assert from 'node:assert/strict'
import { test } from 'node:test'

import { adjacentMineCount, cellKey, createGame, flag, isMine, isRevealed, minesFor, reveal } from './src/engine.mjs'
import { analyze, baselineMove } from './src/baseline.mjs'
import { MAX_QUESTIONS_PER_CALL, buildMineQuestions, calibrationBins, composeMineMove } from './src/jev.mjs'

function crafted(mines, revealed, flags = []) {
	const game = createGame({ width: 4, height: 4, mineCount: mines.length, seed: 1 })
	game.mines = new Set(mines.map(([x, y]) => cellKey(x, y)))
	game.revealed = new Set(revealed.map(([x, y]) => cellKey(x, y)))
	game.flags = new Set(flags.map(([x, y]) => cellKey(x, y)))
	game.minesPlaced = true
	return game
}

test('the first reveal is always mine-free, including its neighbours', () => {
	const game = createGame({ width: 9, height: 9, mineCount: 10, seed: 42 })
	const result = reveal(game, 4, 4)
	assert.equal(result.mine, false)
	for (let y = 3; y <= 5; y++) for (let x = 3; x <= 5; x++) assert.equal(isMine(game, x, y), false)
})

test('adjacentMineCount counts correctly', () => {
	const game = crafted(
		[
			[1, 0],
			[0, 1],
			[1, 1],
		],
		[[0, 0]],
	)
	assert.equal(adjacentMineCount(game, 0, 0), 3)
	assert.equal(adjacentMineCount(game, 3, 3), 0)
})

test('an empty board floods and wins', () => {
	const game = createGame({ width: 4, height: 4, mineCount: 0, seed: 1 })
	reveal(game, 0, 0)
	assert.equal(game.won, true)
})

test('a flag blocks a reveal', () => {
	const game = crafted([[3, 3]], [[0, 0]])
	flag(game, 2, 2)
	assert.equal(reveal(game, 2, 2).ok, false)
	assert.equal(isRevealed(game, 2, 2), false)
})

test('local constraints prove all hidden neighbours are mines', () => {
	const game = crafted(
		[
			[1, 0],
			[0, 1],
			[1, 1],
		],
		[[0, 0]],
	)
	const { mines } = analyze(game)
	assert.deepEqual(mines.map((m) => `${m.x},${m.y}`).sort(), ['0,1', '1,0', '1,1'])
	const move = baselineMove(game)
	assert.equal(move.action, 'flag')
})

test('local constraints prove a hidden neighbour is safe once the mine is flagged', () => {
	const game = crafted([[1, 1]], [[0, 0]], [[1, 1]])
	const { safe } = analyze(game)
	assert.deepEqual(safe.map((m) => `${m.x},${m.y}`).sort(), ['0,1', '1,0'])
	const move = baselineMove(game)
	assert.equal(move.action, 'reveal')
})

test('cautious reveals when a cell is confidently safe', () => {
	const game = crafted([[1, 1]], [[0, 0]], [[1, 1]])
	const cells = [
		{ x: 0, y: 1 },
		{ x: 1, y: 0 },
	]
	const answers = { m_0_1: { noul: 0.02 }, m_1_0: { noul: 0.4 } }
	const move = composeMineMove(game, answers, cells, 'cautious')
	assert.equal(move.action, 'reveal')
	assert.deepEqual({ x: move.x, y: move.y }, { x: 0, y: 1 })
	assert.equal(move.gate, 'model')
})

test('cautious flags when the likeliest mine clears its threshold', () => {
	const game = crafted([[1, 1]], [[0, 0]])
	const cells = [
		{ x: 0, y: 1 },
		{ x: 1, y: 1 },
	]
	const answers = { m_0_1: { noul: 0.3 }, m_1_1: { noul: 0.9 } }
	const move = composeMineMove(game, answers, cells, 'cautious')
	assert.equal(move.action, 'flag')
	assert.deepEqual({ x: move.x, y: move.y }, { x: 1, y: 1 })
})

test('cautious is forced when nothing is safe or clearly a mine', () => {
	const game = crafted([[1, 1]], [[0, 0]])
	const cells = [
		{ x: 0, y: 1 },
		{ x: 1, y: 1 },
	]
	const answers = { m_0_1: { noul: 0.3 }, m_1_1: { noul: 0.35 } }
	const move = composeMineMove(game, answers, cells, 'cautious')
	assert.equal(move.action, 'reveal')
	assert.equal(move.gate, 'forced')
})

test('bold digs through more risk than cautious', () => {
	const game = crafted([[1, 1]], [[0, 0]])
	const cells = [
		{ x: 0, y: 1 },
		{ x: 1, y: 1 },
	]
	const answers = { m_0_1: { noul: 0.3 }, m_1_1: { noul: 0.35 } }
	const move = composeMineMove(game, answers, cells, 'bold')
	assert.equal(move.action, 'reveal')
	assert.equal(move.gate, 'model')
})

test('a uniform board does not spend flags', () => {
	const game = crafted([[0, 0]], [[3, 3]])
	const cells = [
		{ x: 0, y: 0 },
		{ x: 1, y: 1 },
	]
	const answers = { m_0_0: { noul: 0.12 }, m_1_1: { noul: 0.12 } }
	const move = composeMineMove(game, answers, cells, 'cautious')
	assert.equal(move.action, 'reveal')
	assert.equal(move.gate, 'forced')
})

test('minesFor scales with size and difficulty and leaves a safe opening', () => {
	assert.equal(minesFor(9, 9, 'easy'), Math.round(81 * 0.12))
	assert.equal(minesFor(16, 16, 'hard'), Math.round(256 * 0.22))
	assert.ok(minesFor(9, 9, 'hard') <= 81 - 9)
})

test('large boards cap the questions asked per call', () => {
	const game = createGame({ width: 16, height: 16, mineCount: 45, seed: 1 })
	const { cells, totalHidden } = buildMineQuestions(game)
	assert.equal(totalHidden, 256)
	assert.equal(cells.length, MAX_QUESTIONS_PER_CALL)
})

test('calibrationBins groups predictions and outcomes', () => {
	const bins = calibrationBins([
		{ p: 0.05, actual: false },
		{ p: 0.95, actual: true },
		{ p: 0.95, actual: false },
	])
	assert.equal(bins[0].count, 1)
	assert.equal(bins[0].actualRate, 0)
	assert.equal(bins[9].count, 2)
	assert.equal(bins[9].actualRate, 0.5)
	assert.equal(bins[9].avgPredicted.toFixed(2), '0.95')
})
