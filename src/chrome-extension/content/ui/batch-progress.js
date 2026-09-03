;(function (global) {
	'use strict'

	class BatchProgress {
		constructor(items) {
			document.getElementById('push115-batch-panel')?.remove()
			this.panel = document.createElement('section')
			this.panel.id = 'push115-batch-panel'
			this.panel.className = 'push115-batch-panel'
			this.heading = document.createElement('h3')
			this.heading.textContent = `下载任务：0/${items.length}`
			this.panel.appendChild(this.heading)
			this.rows = new Map()
			for (const item of items) {
				const row = document.createElement('div')
				row.className = 'push115-batch-item'
				const name = document.createElement('span')
				name.className = 'push115-batch-name'
				name.textContent = item.title || item.url
				const status = document.createElement('span')
				status.className = 'push115-batch-status'
				status.textContent = 'waiting'
				row.append(name, status)
				this.panel.appendChild(row)
				this.rows.set(item.key, status)
			}
			document.body.appendChild(this.panel)
			this.total = items.length
			this.finishedKeys = new Set()
		}

		update(key, state, message) {
			const status = this.rows.get(key)
			if (!status) return
			status.className = `push115-batch-status ${state || ''}`
			status.textContent = message
			if (['success', 'failed', 'duplicate'].includes(state)) {
				this.finishedKeys.add(key)
				this.heading.textContent = `下载任务：${this.finishedKeys.size}/${this.total}`
			}
		}

		finish(summary) {
			this.heading.textContent = `成功 ${summary.success}　失败 ${summary.failed}　跳过重复 ${summary.duplicate}`
		}
	}

	global.Push115.Content.BatchProgress = { BatchProgress }
})(globalThis)
