;(function (global) {
	'use strict'
	const client = global.Push115.Background.Client
	// Do not fan out 115 file mutations.  A burst of move/rename/delete requests
	// can trigger account-level throttling and make the web file list disappear
	// temporarily.  Reads remain unchanged; every remote mutation shares this
	// one serial queue and waits briefly after the previous response.
	const MUTATION_MIN_INTERVAL_MS = 500
	let mutationChain = Promise.resolve()
	let mutationFinishedAt = 0

	function wait(ms) {
		return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve()
	}

	function enqueueMutation(work) {
		const run = mutationChain.catch(() => {}).then(async () => {
			const delay = MUTATION_MIN_INTERVAL_MS - (Date.now() - mutationFinishedAt)
			await wait(Math.max(0, delay))
			try {
				return await work()
			} finally {
				mutationFinishedAt = Date.now()
			}
		})
		// Keep the queue alive after an individual 115 response fails; callers still
		// receive the original rejection and can retry their persisted task.
		mutationChain = run.catch(() => {})
		return run
	}

	function operationSucceeded(result) {
		return result?.state === true || result?.state === 1 || result?.state === '1'
	}

	async function list(cid = '0', offset = 0) {
		return client.data({
			url: `https://webapi.115.com/files?aid=1&cid=${cid}&o=user_ptime&asc=0&offset=${offset}&show_dir=1&limit=500&snap=0&natsort=1`,
			method: 'GET',
		})
	}

	async function createFolder(parentCid, folderName) {
		return enqueueMutation(() => client.data({
			url: 'https://webapi.115.com/files/add', method: 'POST',
			data: { pid: parentCid, cname: folderName },
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		}))
	}

	async function move(fid, targetCid) {
		return enqueueMutation(() => client.data({
			url: 'https://webapi.115.com/files/move', method: 'POST',
			data: { pid: targetCid, fid, move_proid: '' },
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		}))
	}

	async function rename(fid, newName) {
		return enqueueMutation(() => client.data({
			url: 'https://webapi.115.com/files/edit', method: 'POST', data: { fid, name: newName },
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		}))
	}

	async function remove(fids) {
		const ids = (Array.isArray(fids) ? fids : [fids]).filter(Boolean)
		if (ids.length === 0) return { state: true }
		const params = new URLSearchParams()
		ids.forEach((fid, index) => params.append(`fid[${index}]`, fid))
		params.append('ignore_warn', '1')
		return enqueueMutation(() => client.data({
			url: 'https://webapi.115.com/rb/delete', method: 'POST', data: params.toString(),
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		}))
	}

	global.Push115.Background.FilesApi = {
		list, createFolder, move, rename, remove, operationSucceeded,
		mutationPolicy: Object.freeze({ concurrency: 1, minIntervalMs: MUTATION_MIN_INTERVAL_MS }),
	}
})(globalThis)
