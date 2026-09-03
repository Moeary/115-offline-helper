;(function (global) {
	'use strict'
	const client = global.Push115.Background.Client

	async function getTasks() {
		const result = await client.data({ url: 'https://115.com/web/lixian/?ct=lixian&ac=task_lists', method: 'GET' })
		if (result?.state) return result.tasks || result.data?.tasks || []
		throw new Error('获取任务列表失败')
	}

	async function addTask(url, savePathCid) {
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
	}

	global.Push115.Background.OfflineApi = { getTasks, addTask }
})(globalThis)
