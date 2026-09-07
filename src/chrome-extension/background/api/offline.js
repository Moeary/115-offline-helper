;(function (global) {
	'use strict'
	const background = global.Push115.Background
	const client = background.Client
	// Reuse the same account-wide limiter as FilesApi.  This also throttles the
	// task-list poll used by the post-processing monitor, so it cannot leapfrog a
	// directory scan and create a burst of 115 requests.
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
	let submissionChain = Promise.resolve()

	function enqueueSubmission(work) {
		const run = submissionChain.catch(() => {}).then(work)
		submissionChain = run.catch(() => {})
		return run
	}

	async function getTasks() {
		const result = await requestQueue.enqueue(() => client.data({ url: 'https://115.com/web/lixian/?ct=lixian&ac=task_lists', method: 'GET' }))
		if (result?.state) return result.tasks || result.data?.tasks || []
		throw new Error('获取任务列表失败')
	}

	async function addTask(url, savePathCid) {
		return enqueueSubmission(async () => {
			const userResult = await requestQueue.enqueue(() => client.data({ url: 'https://my.115.com/?ct=ajax&ac=nav', method: 'GET' }))
			const uid = userResult?.data?.user_id
			const tokenResult = await requestQueue.enqueue(() => client.data({ url: 'https://115.com/?ct=offline&ac=space', method: 'GET' }))
			const sign = tokenResult?.sign
			const time = tokenResult?.time
			const result = await requestQueue.enqueue(() => client.data({
				url: 'https://115.com/web/lixian/?ct=lixian&ac=add_task_url',
				method: 'POST',
				data: { url, uid, sign, time, wp_path_id: savePathCid, savepath: '' },
			}))
			if (!result?.state) throw new Error(result?.error_msg || '115 离线任务提交失败')
			return result
		})
	}

	global.Push115.Background.OfflineApi = {
		getTasks, addTask,
		requestPolicy: requestQueue.policy,
		submissionPolicy: Object.freeze({ concurrency: 1, minIntervalMs: requestQueue.policy.minIntervalMs }),
	}
})(globalThis)
