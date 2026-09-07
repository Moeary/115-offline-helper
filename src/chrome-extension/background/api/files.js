;(function (global) {
	'use strict'
	const background = global.Push115.Background
	const client = background.Client
	// Reads and mutations use one account-wide queue.  Directory scans are part
	// of post-processing too; leaving GETs unthrottled would still make a batch
	// of Mikan episodes burst requests even when moves are serialized.
	const requestQueue = background.RequestQueue || (() => {
		const MIN_INTERVAL_MS = 500
		let chain = Promise.resolve()
		let finishedAt = 0
		const enqueue = work => {
			const run = chain.catch(() => {}).then(async () => {
				const delay = MIN_INTERVAL_MS - (Date.now() - finishedAt)
				if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
				try { return await work() } finally { finishedAt = Date.now() }
			})
			chain = run.catch(() => {})
			return run
		}
		return background.RequestQueue = {
			enqueue,
			policy: Object.freeze({ concurrency: 1, minIntervalMs: MIN_INTERVAL_MS }),
		}
	})()

	function operationSucceeded(result) {
		return result?.state === true || result?.state === 1 || result?.state === '1'
	}

	async function list(cid = '0', offset = 0) {
		return requestQueue.enqueue(() => client.data({
			url: `https://webapi.115.com/files?aid=1&cid=${cid}&o=user_ptime&asc=0&offset=${offset}&show_dir=1&limit=500&snap=0&natsort=1`,
			method: 'GET',
		}))
	}

	async function createFolder(parentCid, folderName) {
		return requestQueue.enqueue(() => client.data({
			url: 'https://webapi.115.com/files/add', method: 'POST',
			data: { pid: parentCid, cname: folderName },
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		}))
	}

	async function move(fid, targetCid) {
		return requestQueue.enqueue(() => client.data({
			url: 'https://webapi.115.com/files/move', method: 'POST',
			data: { pid: targetCid, fid, move_proid: '' },
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		}))
	}

	async function rename(fid, newName) {
		return requestQueue.enqueue(() => client.data({
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
		return requestQueue.enqueue(() => client.data({
			url: 'https://webapi.115.com/rb/delete', method: 'POST', data: params.toString(),
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		}))
	}

	global.Push115.Background.FilesApi = {
		list, createFolder, move, rename, remove, operationSucceeded,
		requestPolicy: requestQueue.policy,
		// Keep the old public contract for callers that only care about writes.
		mutationPolicy: requestQueue.policy,
	}
})(globalThis)
