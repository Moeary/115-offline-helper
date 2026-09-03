;(function (global) {
	'use strict'

	function makeBatchId() {
		if (global.crypto?.randomUUID) return global.crypto.randomUUID()
		return `batch-${Date.now()}-${Math.random().toString(16).slice(2)}`
	}

	function normalizeItems(rawItems = [], batchId = '') {
		const seen = new Map()
		return rawItems.map((raw, index) => {
			const original = global.Push115.DownloadIntent.create(raw.intent || raw)
			// 标记同一次确认窗口提交的 anime 任务。后台据此把批量下载
			// 扁平化到同一个保存目录；单条 anime 仍保持原有目录结构。
			const intent = batchId
				? global.Push115.DownloadIntent.create({
					...original,
					metadata: { ...original.metadata, batchId },
				})
				: original
			const key = raw.key || `task-${index + 1}`
			const dedupeKey = global.Push115.DownloadIntent.dedupeKey(intent.url)
			if (seen.has(dedupeKey)) {
				return { key, intent, dedupeKey, status: 'duplicate', duplicateOf: seen.get(dedupeKey) }
			}
			seen.set(dedupeKey, key)
			return { key, intent, dedupeKey, status: 'waiting' }
		})
	}

	async function submit(rawItems, options = {}) {
		const items = Array.isArray(rawItems) ? rawItems : []
		const batchId = options.batchId || (items.length > 1 ? makeBatchId() : '')
		const entries = normalizeItems(items, batchId)
		const concurrency = Math.min(6, Math.max(1, Math.round(Number(options.concurrency) || 2)))
		const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {}
		for (const entry of entries) onStatus(entry, entry.status)

		const pending = entries.filter(entry => entry.status === 'waiting')
		let cursor = 0
		async function worker() {
			while (cursor < pending.length) {
				const entry = pending[cursor++]
				entry.status = 'submitting'
				onStatus(entry, entry.status)
				try {
					entry.response = await global.Push115.Messaging.send('SUBMIT_INTENT', { intent: entry.intent })
					entry.status = 'success'
				} catch (error) {
					entry.error = error
					entry.status = 'failed'
				}
				onStatus(entry, entry.status)
			}
		}

		await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker))
		return {
			entries,
			success: entries.filter(entry => entry.status === 'success').length,
			failed: entries.filter(entry => entry.status === 'failed').length,
			duplicate: entries.filter(entry => entry.status === 'duplicate').length,
		}
	}

	global.Push115.SubmissionQueue = { normalizeItems, submit }
})(globalThis)
