;(function (global) {
	'use strict'

	function statusLabel(status) {
		return t(`task_status_${status}`) || status || t('task_status_recorded')
	}

	function displayName(task) {
		return task.code || task.remoteName || task.title || task.url || task.magnet || '115 task'
	}

	function formatTime(value) {
		const timestamp = Number(value)
		if (!Number.isFinite(timestamp) || timestamp <= 0) return '--'
		return new Date(timestamp).toLocaleString(document.documentElement.lang || 'zh-CN', { hour12: false })
	}

	function appendLogs(parent, task) {
		const logs = Array.isArray(task.logs) ? task.logs : []
		const details = document.createElement('details')
		details.className = 'push115-task-logs'
		details.open = task.status === 'failed' || task.status === 'processing'
		const summary = document.createElement('summary')
		summary.textContent = `${t('logs_label')} (${logs.length})`
		details.appendChild(summary)
		if (logs.length === 0) {
			const empty = document.createElement('div')
			empty.className = 'push115-log-entry'
			empty.textContent = t('task_meta_empty')
			details.appendChild(empty)
		} else {
			for (const log of logs.slice(-60)) {
				const entry = document.createElement('div')
				entry.className = 'push115-log-entry'
				const time = document.createElement('time')
				time.textContent = formatTime(log.at)
				const message = document.createElement('span')
				message.textContent = log.message || ''
				entry.append(time, message)
				details.appendChild(entry)
			}
		}
		parent.appendChild(details)
	}

	function render(tasks = []) {
		const list = document.getElementById('push115-log-list')
		const summary = document.getElementById('push115-log-summary')
		const ordered = [...tasks].sort((left, right) => (right.updatedAt || right.createdAt || 0) - (left.updatedAt || left.createdAt || 0))
		summary.textContent = replaceCount(t('logs_summary'), ordered.length)
		list.textContent = ''
		if (ordered.length === 0) {
			const empty = document.createElement('div')
			empty.className = 'push115-log-empty'
			empty.textContent = t('logs_empty')
			list.appendChild(empty)
			return
		}

		for (const task of ordered) {
			const status = ['waiting', 'processing', 'recorded', 'completed', 'failed'].includes(task.status) ? task.status : 'recorded'
			const card = document.createElement('article')
			card.className = `push115-task-card ${status}`
			const header = document.createElement('div')
			header.className = 'push115-task-card-header'
			const title = document.createElement('div')
			title.className = 'push115-task-card-title'
			title.textContent = displayName(task)
			const statusElement = document.createElement('span')
			statusElement.className = 'push115-task-card-status'
			statusElement.textContent = statusLabel(status)
			header.append(title, statusElement)
			card.appendChild(header)
			const meta = document.createElement('div')
			meta.className = 'push115-task-card-meta'
			const metaParts = [task.title, task.sourceSite || task.source, task.mediaType, task.processorProfile, task.message, formatTime(task.updatedAt || task.createdAt)].filter(Boolean)
			meta.textContent = metaParts.length > 0 ? metaParts.join(' · ') : t('task_meta_empty')
			card.appendChild(meta)
			if (status === 'failed') {
				const retry = document.createElement('button')
				retry.className = 'push115-task-retry'
				retry.type = 'button'
				retry.textContent = t('task_retry')
				retry.addEventListener('click', async () => {
					retry.disabled = true
					try {
						await sendMessage('RETRY_TASK', { taskId: task.taskId })
						await refresh()
					} catch (error) {
						showSettingsStatus('error', t('task_retry_failed') + (error?.message || error))
						retry.disabled = false
					}
				})
				const actions = document.createElement('div')
				actions.className = 'push115-task-card-actions'
				actions.appendChild(retry)
				card.appendChild(actions)
			}
			appendLogs(card, task)
			list.appendChild(card)
		}
	}

	async function refresh() {
		try {
			const response = await sendMessage('GET_TASKS')
			render(response.tasks || [])
		} catch (error) {
			document.getElementById('push115-log-summary').textContent = t('refresh_failed') + (error?.message || error)
		}
	}

	async function clearLogs() {
		if (!window.confirm(t('confirm_clear_logs'))) return
		const button = document.getElementById('push115-clear-logs')
		if (button) button.disabled = true
		try {
			const response = await sendMessage('CLEAR_LOGS')
			await refresh()
			showTaskStatus('success', replaceCount(t('clear_logs_success'), response.retained || 0))
		} catch (error) {
			showTaskStatus('error', t('clear_logs_failed') + (error?.message || error))
		} finally {
			if (button) button.disabled = false
		}
	}

	function showTaskStatus(type, message) {
		const area = document.getElementById('push115-log-status') || document.getElementById('push115-settings-status')
		if (!area) return
		area.className = `push115-status ${type || ''}`
		area.textContent = message || ''
	}

	function replaceResetCounts(text, tasks, series) {
		return String(text || '')
			.replace('{tasks}', String(tasks || 0))
			.replace('{series}', String(series || 0))
	}

	async function completeReset() {
		if (!window.confirm(t('confirm_complete_reset'))) return
		const button = document.getElementById('push115-complete-reset')
		if (button) button.disabled = true
		try {
			const response = await sendMessage('RESET_RUNTIME')
			await refresh()
			showTaskStatus('success', replaceResetCounts(
				t('complete_reset_success'),
				response.tasksCleared,
				response.seriesCleared,
			))
		} catch (error) {
			showTaskStatus('error', t('complete_reset_failed') + (error?.message || error))
		} finally {
			if (button) button.disabled = false
		}
	}

	global.Push115.OptionsTasks = { render, refresh, clearLogs, completeReset }
})(globalThis)
