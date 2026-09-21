import {
	DIFFICULTIES,
	SIZES,
	adjacentMineCount,
	createGame,
	flag,
	isFlagged,
	isMine,
	isRevealed,
	minesFor,
	reveal,
	serialize,
	unflag,
} from '/src/engine.mjs'

const $ = (id) => document.getElementById(id)

const state = {
	game: null,
	mode: 'jev', // 'jev' | 'you'
	persona: 'cautious',
	running: false,
	loopToken: 0,
	probabilities: [],
	lastPayload: null,
	moves: 0,
	usage: { input_tokens: 0, output_tokens: 0 },
	pricePerMillionInputUsd: 0.042,
	latencyMs: 0,
	showHeat: true,
	gameOver: false,
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

function newGame() {
	const size = SIZES[$('size').value] ?? SIZES.small
	const difficulty = $('difficulty').value
	const mineCount = minesFor(size.width, size.height, difficulty)
	state.loopToken += 1
	state.game = createGame({
		width: size.width,
		height: size.height,
		mineCount,
		seed: Math.floor(Math.random() * 1e9),
	})
	state.running = false
	state.gameOver = false
	state.probabilities = []
	state.lastPayload = null
	state.moves = 0
	state.usage = { input_tokens: 0, output_tokens: 0 }
	state.latencyMs = 0
	buildGrid()
	updatePlayButton()
	hideOverlay()
	render()
	updateStats()
}

function buildGrid() {
	const board = $('board')
	board.style.gridTemplateColumns = `repeat(${state.game.width}, minmax(0, 1fr))`
	board.style.gridTemplateRows = `repeat(${state.game.height}, minmax(0, 1fr))`
	board.style.aspectRatio = `${state.game.width} / ${state.game.height}`
	board.innerHTML = ''
	for (let y = 0; y < state.game.height; y++) {
		for (let x = 0; x < state.game.width; x++) {
			const cell = document.createElement('div')
			cell.className = 'cell covered'
			cell.dataset.x = String(x)
			cell.dataset.y = String(y)
			cell.addEventListener('click', () => onCellClick(x, y))
			cell.addEventListener('contextmenu', (event) => {
				event.preventDefault()
				onCellFlag(x, y)
			})
			board.appendChild(cell)
		}
	}
}

function riskFor(x, y) {
	const entry = state.probabilities.find((p) => p.x === x && p.y === y)
	return entry && typeof entry.p === 'number' ? entry.p : null
}

function render() {
	const game = state.game
	const board = $('board')
	const target = state.lastPayload?.decision
	for (let y = 0; y < game.height; y++) {
		for (let x = 0; x < game.width; x++) {
			const element = board.children[y * game.width + x]
			const classes = ['cell']
			if (isRevealed(game, x, y)) {
				classes.push('revealed')
				const number = adjacentMineCount(game, x, y)
				if (number > 0) classes.push(`n${number}`)
				element.textContent = number === 0 ? '' : String(number)
			} else if (isFlagged(game, x, y)) {
				classes.push('flag')
				element.textContent = '⚑'
			} else {
				classes.push('covered')
				element.textContent = ''
			}
			if (game.lost && isMine(game, x, y)) {
				classes.push('mine')
				element.textContent = '✱'
			}
			if (target && target.x === x && target.y === y && !isRevealed(game, x, y)) classes.push('target')
			element.className = classes.join(' ')
			const risk = state.showHeat && !isRevealed(game, x, y) && !isFlagged(game, x, y) ? riskFor(x, y) : null
			element.style.background = risk !== null ? `rgba(255, 84, 112, ${(risk * 0.55).toFixed(3)})` : ''
		}
	}
}

// ---------------------------------------------------------------------------
// Play
// ---------------------------------------------------------------------------

function onCellClick(x, y) {
	if (state.mode !== 'you' || state.gameOver) return
	if (isFlagged(state.game, x, y) || isRevealed(state.game, x, y)) return
	reveal(state.game, x, y)
	afterMove()
}

function onCellFlag(x, y) {
	if (state.mode !== 'you' || state.gameOver) return
	if (isRevealed(state.game, x, y)) return
	if (isFlagged(state.game, x, y)) unflag(state.game, x, y)
	else flag(state.game, x, y)
	afterMove()
}

function applyDecision(decision) {
	if (!decision) return
	if (decision.action === 'flag') flag(state.game, decision.x, decision.y)
	else reveal(state.game, decision.x, decision.y)
}

function afterMove() {
	state.moves += 1
	render()
	updateStats()
	if (state.game.won || state.game.lost) finish()
}

async function jevStep() {
	if (state.gameOver) return
	const token = state.loopToken
	try {
		const response = await fetch('/api/decide', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ state: serialize(state.game), persona: state.persona }),
		})
		const data = await response.json()
		if (token !== state.loopToken) return
		if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`)
		if (!data.decision) {
			finish()
			return
		}
		state.lastPayload = data
		state.probabilities = data.probabilities ?? []
		state.latencyMs = data.latencyMs ?? 0
		if (data.usage) {
			state.usage.input_tokens += data.usage.input_tokens ?? 0
			state.usage.output_tokens += data.usage.output_tokens ?? 0
		}
		renderAnswers(data)
		applyDecision(data.decision)
		afterMove()
		if (state.gameOver || !state.running) return
		setTimeout(jevStep, 350)
	} catch (error) {
		console.error(error)
		state.running = false
		updatePlayButton()
		showOverlay('Jev call failed', error.message)
	}
}

function toggleRunning() {
	if (state.gameOver) newGame()
	if (state.mode !== 'jev') setMode('jev')
	state.running = !state.running
	updatePlayButton()
	if (state.running) {
		hideOverlay()
		jevStep()
	} else {
		state.loopToken += 1
	}
}

function finish() {
	state.gameOver = true
	state.running = false
	updatePlayButton()
	render()
	if (state.game.won) showOverlay('Cleared', `Nice. ${state.moves} moves.`)
	else showOverlay('Boom', `Hit a mine after ${state.moves} moves.`)
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function updateStats() {
	$('stat-mines').textContent = String(state.game.mineCount)
	$('stat-flags').textContent = String(state.game.flags.size)
	$('stat-moves').textContent = String(state.moves)
	$('stat-latency').textContent = state.latencyMs ? `${Math.round(state.latencyMs)}ms` : '—'
	const cost = (state.usage.input_tokens / 1_000_000) * state.pricePerMillionInputUsd
	$('cost-total').textContent = `$${cost.toFixed(6)}`
	$('cost-detail').textContent = `${state.usage.input_tokens.toLocaleString()} input tokens`
}

function renderAnswers(data) {
	const container = $('answers')
	const decision = data.decision ?? {}
	const trace = decision.trace ?? {}
	const parts = []
	parts.push(`
		<div class="answer-row">
			<div class="answer-head"><span class="answer-key">action</span>
			<span class="answer-value">${escapeHtml(decision.action ?? '—')} (${decision.x ?? '?'}, ${decision.y ?? '?'})</span></div>
		</div>`)
	parts.push(`
		<div class="answer-row">
			<div class="answer-head"><span class="answer-key">safest cell</span>
			<span class="answer-value">P(mine) ${trace.safest ? trace.safest.p : '—'}</span></div>
		</div>`)
	parts.push(`
		<div class="answer-row">
			<div class="answer-head"><span class="answer-key">likeliest mine</span>
			<span class="answer-value">P(mine) ${trace.mostLikelyMine ? trace.mostLikelyMine.p : '—'}</span></div>
		</div>`)

	const ranked = [...state.probabilities]
		.filter((p) => typeof p.p === 'number')
		.sort((a, b) => a.p - b.p)
		.slice(0, 5)
	if (ranked.length > 0) {
		parts.push(
			`<div class="bars">${ranked.map((entry) => barRow(`(${entry.x},${entry.y})`, entry.p)).join('')}</div>`,
		)
	}
	if (decision.reason) parts.push(`<div class="reason">${escapeHtml(decision.reason)}</div>`)
	container.innerHTML = parts.join('')

	const badge = $('gate-badge')
	badge.className = 'badge'
	if (decision.gate === 'model') badge.classList.add('badge-act')
	else if (decision.gate === 'solver') badge.classList.add('badge-solver')
	else if (decision.gate === 'forced') badge.classList.add('badge-forced')
	else if (decision.gate === 'fallback') badge.classList.add('badge-fallback')
	else badge.classList.add('badge-muted')
	badge.textContent = decision.gate ? `code gate: ${decision.gate}` : 'idle'

	const inspect = $('inspect')
	if (!inspect.classList.contains('hidden')) inspect.textContent = JSON.stringify(data, null, 2)
}

function barRow(label, p) {
	const percentage = Math.max(0, Math.min(1, p))
	return `<div class="bar">
		<span class="bar-label">${escapeHtml(label)}</span>
		<span class="bar-track"><span class="bar-fill" style="width:${(percentage * 100).toFixed(1)}%"></span></span>
		<span class="bar-pct">${(percentage * 100).toFixed(0)}%</span>
	</div>`
}

function escapeHtml(value) {
	return String(value).replace(
		/[&<>"']/g,
		(character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
	)
}

function showOverlay(title, text) {
	$('overlay-title').textContent = title
	$('overlay-text').textContent = text
	$('overlay').classList.remove('hidden')
}

function hideOverlay() {
	$('overlay').classList.add('hidden')
}

function updatePlayButton() {
	$('step').textContent = state.running ? '❚❚ Pause' : '▶ Jev digs'
}

function setMode(mode) {
	state.mode = mode
	state.loopToken += 1
	state.running = false
	updatePlayButton()
	$('mode-jev').classList.toggle('active', mode === 'jev')
	$('mode-you').classList.toggle('active', mode === 'you')
	hideOverlay()
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function populateSelectors() {
	const size = $('size')
	for (const [key, definition] of Object.entries(SIZES)) {
		size.append(new Option(`${definition.label} ${definition.width}×${definition.height}`, key))
	}
	size.value = 'small'
	const difficulty = $('difficulty')
	for (const [key, definition] of Object.entries(DIFFICULTIES)) {
		difficulty.append(new Option(definition.label, key))
	}
	difficulty.value = 'medium'
}

function bindControls() {
	populateSelectors()
	$('new').addEventListener('click', newGame)
	$('size').addEventListener('change', newGame)
	$('difficulty').addEventListener('change', newGame)
	$('step').addEventListener('click', toggleRunning)
	$('mode-jev').addEventListener('click', () => setMode('jev'))
	$('mode-you').addEventListener('click', () => setMode('you'))
	$('persona').addEventListener('change', (event) => {
		state.persona = event.target.value
	})
	$('heat').addEventListener('change', (event) => {
		state.showHeat = event.target.checked
		render()
	})
	$('inspect-toggle').addEventListener('click', () => {
		const inspect = $('inspect')
		const hidden = inspect.classList.toggle('hidden')
		$('inspect-toggle').textContent = hidden ? 'Show request + answer' : 'Hide request + answer'
		if (!hidden && state.lastPayload) renderAnswers(state.lastPayload)
	})
}

async function loadHealth() {
	try {
		const response = await fetch('/api/health')
		const health = await response.json()
		const badge = $('mode-badge')
		if (health.mode === 'jev') {
			badge.className = 'badge badge-live'
			badge.textContent = 'JEV LIVE'
		} else {
			badge.className = 'badge badge-sim'
			badge.textContent = 'SIMULATED (no key)'
		}
		$('model-badge').className = 'badge badge-muted'
		$('model-badge').textContent = health.model
		if (typeof health.pricePerMillionInputUsd === 'number') {
			state.pricePerMillionInputUsd = health.pricePerMillionInputUsd
			$('price-label').textContent = `$${health.pricePerMillionInputUsd} / 1M input tokens, output free`
		}
	} catch {
		$('mode-badge').textContent = 'server offline'
	}
}

function init() {
	bindControls()
	newGame()
	loadHealth()
}

init()
