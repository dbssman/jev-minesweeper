#!/usr/bin/env node
// Jev Minesweeper — zero-dependency demo server.
// Keeps the TypeSafe API key server-side and turns Jev's per-cell mine
// probabilities into a move, with the policy thresholds owned by code here.

import http from 'node:http'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { deserialize, render, serialize } from './src/engine.mjs'
import { baselineMove, solverOnlyMove } from './src/baseline.mjs'
import {
	API_URL_DEFAULT,
	MODEL_DEFAULT,
	PERSONAS,
	PRICE_PER_MILLION_INPUT_USD,
	buildMineQuestions,
	buildMineState,
	callJev,
	composeMineMove,
} from './src/jev.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, 'public')
const SRC_DIR = path.join(__dirname, 'src')

const CONSUMED_ENV_KEYS = [
	'TYPESAFE_API_KEY',
	'TYPESAFE_MODEL',
	'TYPESAFE_API_URL',
	'TYPESAFE_TIMEOUT_MS',
	'PORT',
	'JEV_DEMO_PORT',
	'HOST',
]

function parseEnv(contents) {
	const out = {}
	for (const rawLine of contents.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith('#')) continue
		const equalsIndex = line.indexOf('=')
		if (equalsIndex === -1) continue
		const key = line.slice(0, equalsIndex).trim()
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
		let value = line.slice(equalsIndex + 1).trim()
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1)
		} else {
			const hash = value.indexOf(' #')
			if (hash !== -1) value = value.slice(0, hash).trim()
		}
		if (value) out[key] = value
	}
	return out
}

function loadEnvironment() {
	const fileEnv = {}
	for (const file of [path.join(__dirname, '.env'), path.resolve(__dirname, '../../.env')]) {
		try {
			const parsed = parseEnv(readFileSync(file, 'utf8'))
			for (const [name, value] of Object.entries(parsed)) if (!(name in fileEnv)) fileEnv[name] = value
		} catch {
			/* file not present */
		}
	}
	for (const name of CONSUMED_ENV_KEYS) {
		if (!process.env[name] && fileEnv[name]) process.env[name] = fileEnv[name]
	}
	return { apiKey: process.env.TYPESAFE_API_KEY || '' }
}

const ENV = loadEnvironment()
const HOST = process.env.HOST ?? '127.0.0.1'
const PORT = Number(process.env.PORT ?? process.env.JEV_DEMO_PORT ?? 4322)
const MODEL = process.env.TYPESAFE_MODEL ?? MODEL_DEFAULT
const API_URL = process.env.TYPESAFE_API_URL ?? API_URL_DEFAULT
const REQUEST_TIMEOUT_MS = Number(process.env.TYPESAFE_TIMEOUT_MS ?? 20000)

const CONTENT_TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
}

function sendJson(response, status, payload) {
	const body = JSON.stringify(payload)
	response.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
		'Content-Length': Buffer.byteLength(body),
	})
	response.end(body)
}

async function readBody(request) {
	const chunks = []
	let size = 0
	for await (const chunk of request) {
		size += chunk.length
		if (size > 1_000_000) throw new Error('Payload too large')
		chunks.push(chunk)
	}
	if (chunks.length === 0) return {}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'))
	} catch {
		throw new Error('Invalid JSON body')
	}
}

async function serveFile(response, rootDir, relativePath) {
	const resolved = path.resolve(rootDir, relativePath)
	const inside = path.relative(rootDir, resolved)
	if (inside.startsWith('..') || path.isAbsolute(inside)) {
		response.writeHead(403).end('Forbidden')
		return
	}
	try {
		const file = await readFile(resolved)
		response.writeHead(200, {
			'Content-Type': CONTENT_TYPES[path.extname(resolved)] ?? 'application/octet-stream',
			'Cache-Control': 'no-store',
		})
		response.end(file)
	} catch {
		response.writeHead(404).end('Not found')
	}
}

async function handleDecide(request, response) {
	const body = await readBody(request)
	const game = deserialize(body?.state ?? {})
	const persona = Object.hasOwn(PERSONAS, body?.persona) ? body.persona : 'cautious'

	if (game.lost || game.won) {
		sendJson(response, 200, { mode: 'idle', decision: null, note: 'Game is over.' })
		return
	}

	if (!ENV.apiKey) {
		const decision = baselineMove(game)
		sendJson(response, 200, {
			mode: 'simulated',
			model: 'local-baseline',
			latencyMs: 0,
			usage: { input_tokens: 0, output_tokens: 0 },
			decision,
			probabilities: [],
			persona,
			note: 'TYPESAFE_API_KEY is not set — running the deterministic baseline bot. Set the key and reload to let Jev play.',
		})
		return
	}

	const state = buildMineState(game, persona)
	const { questions, cells } = buildMineQuestions(game)
	try {
		const result = await callJev({
			apiKey: ENV.apiKey,
			state,
			questions,
			model: MODEL,
			apiUrl: API_URL,
			timeoutMs: REQUEST_TIMEOUT_MS,
		})
		// Code takes any move local constraints can prove; Jev's probabilities are
		// used only where deduction runs out (the genuine guesses).
		const composed = composeMineMove(game, result.answers, cells, persona)
		const proven = solverOnlyMove(game)
		const decision = proven ??
			composed ?? {
				...baselineMove(game),
				gate: 'fallback',
				reason: 'No usable probabilities from Jev; baseline took over.',
			}
		const probabilities = cells.map(({ x, y }) => ({ x, y, p: result.answers?.[`m_${x}_${y}`]?.noul ?? null }))
		sendJson(response, 200, {
			mode: 'jev',
			model: result.model,
			latencyMs: result.latencyMs,
			usage: result.usage,
			decision,
			probabilities,
			persona,
			request: { model: MODEL, state, questions },
		})
	} catch (error) {
		const decision = baselineMove(game)
		sendJson(response, 200, {
			mode: 'jev',
			model: MODEL,
			latencyMs: 0,
			usage: { input_tokens: 0, output_tokens: 0 },
			decision: decision
				? { ...decision, gate: 'fallback', reason: `Jev call failed (${error.message}); baseline took over.` }
				: null,
			probabilities: [],
			persona,
			error: error.message,
		})
	}
}

const server = http.createServer(async (request, response) => {
	const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
	try {
		if (request.method === 'GET' && url.pathname === '/api/health') {
			sendJson(response, 200, {
				mode: ENV.apiKey ? 'jev' : 'simulated',
				model: ENV.apiKey ? MODEL : 'local-baseline',
				hasKey: Boolean(ENV.apiKey),
				pricePerMillionInputUsd: PRICE_PER_MILLION_INPUT_USD,
			})
			return
		}
		if (request.method === 'POST' && url.pathname === '/api/decide') {
			await handleDecide(request, response)
			return
		}
		if (request.method === 'GET' && url.pathname.startsWith('/src/')) {
			await serveFile(response, SRC_DIR, url.pathname.replace(/^\/src\//, ''))
			return
		}
		if (request.method === 'GET') {
			await serveFile(
				response,
				PUBLIC_DIR,
				url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, ''),
			)
			return
		}
		response.writeHead(405).end('Method not allowed')
	} catch (error) {
		sendJson(response, 400, { error: error.message })
	}
})

const isEntryPoint = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false
if (isEntryPoint) {
	server.listen(PORT, HOST, () => {
		const banner = ENV.apiKey
			? `Jev Minesweeper — model ${MODEL} (TypeSafe API key detected)`
			: 'Jev Minesweeper — SIMULATED mode (no TYPESAFE_API_KEY; add it to the environment to let Jev play)'
		console.log(`\n  ${banner}`)
		console.log(`  -> http://${HOST}:${PORT}\n`)
	})
}

export { server, render, serialize, deserialize }
