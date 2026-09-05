;(function (global) {
	'use strict'
	const client = global.Push115.Background.Client
	// Keep the multi-request add-task handshake serial as well.  Even though the
	// page queue has a small cap, each submission performs several authenticated
	// requests and parallel handshakes can still trip 115's rate controls.
	const SUBMISSION_MIN_INTERVAL_MS = 500
	let submissionChain = Promise.resolve()
	let submissionFinishedAt = 0

	function wait(ms) {
		return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve()
	}

	function enqueueSubmission(work) {
		const run = submissionChain.catch(() => {}).then(async () => {
			const delay = SUBMISSION_MIN_INTERVAL_MS - (Date.now() - submissionFinishedAt)
			await wait(Math.max(0, delay))
			try {
				return await work()
			} finally {
				submissionFinishedAt = Date.now()
			}
		})
		submissionChain = run.catch(() => {})
		return run
	}

	async function getTasks() {
		const result = await client.data({ url: 'https://115.com/web/lixian/?ct=lixian&ac=task_lists', method: 'GET' })
		if (result?.state) return result.tasks || result.data?.tasks || []
		throw new Error('获取任务列表失败')
	}

	async function addTask(url, savePathCid) {
		return enqueueSubmission(async () => {
			const userResult = await client.data({ url: 'https://my.115.com/?ct=ajax&ac=nav', method: 'GET' })
			const uid = userResult?.data?.user_id
			const tokenResult = await client.data({ url: 'https://115.com/?ct=offline&ac=space', method: 'GET' })
			const sign = tokenResult?.sign
			const time = tokenResult?.time
			const result = await client.data({
				url: 'https://115.com/web/lixian/?ct=lixian&ac=add_task_url',
				method: 'POST',
				data: { url, uid, sign, time, wp_path_id: savePathCid, savepath: '' },
			})
			if (!result?.state) throw new Error(result?.error_msg || '115 离线任务提交失败')
			return result
		})
	}

	global.Push115.Background.OfflineApi = {
		getTasks, addTask,
		submissionPolicy: Object.freeze({ concurrency: 1, minIntervalMs: SUBMISSION_MIN_INTERVAL_MS }),
	}
})(globalThis)
