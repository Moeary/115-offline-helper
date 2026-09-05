;(function (global) {
	'use strict'
	const content = global.Push115.Content = global.Push115.Content || {}
	const pathUtils = global.Push115.PathUtils
	const intentApi = global.Push115.DownloadIntent
	const SITE_LABELS = Object.freeze({ generic: 'Generic', javbus: 'JavBus', nyaa: 'Nyaa', sukebei: 'Sukebei', mikan: 'Mikan' })
	const PROFILE_LABELS = Object.freeze({ generic: 'Generic', jav: 'JAV', anime: 'Anime' })

	function normalizeInput(input) {
		if (Array.isArray(input)) return { intents: input }
		if (input?.intents || input?.initialText !== undefined) return input
		return { intents: input ? [input] : [] }
	}

	function profileWarning(profile, intents) {
		if (profile === 'jav') {
			const code = intents.find(intent => intent.code || intent.metadata?.pageCode)?.code
			return `JAV 规则会尝试按番号重命名主视频、字幕和文件夹。${code ? `当前番号：${code}` : '当前未检测到明确番号，将谨慎依现有文件名处理。'}`
		}
		if (profile === 'anime') return 'Anime 单条任务保留 torrent 原有名称和目录结构；一次确认提交多条时，下载完成后会将视频/字幕移到所选保存目录，并只删除确认为空的任务文件夹。'
		return 'Generic 规则只执行已启用的通用安全清理，不会按番号重命名。'
	}

	function rowLabel(row) {
		return `第 ${row.line} 行：${row.status === 'invalid' ? row.message : `重复于第 ${row.duplicateOf} 行`}`
	}

	async function show(rawInput) {
		const input = normalizeInput(rawInput)
		const config = await global.Push115.Config.loadConfig()
		const keys = global.Push115.Config.STORAGE_KEYS
		const intents = (input.intents || []).map(intent => intentApi.create(intent))
		const sourceSite = String(input.sourceSite || intents[0]?.sourceSite || 'generic').toLowerCase()
		const siteProfile = config[keys.SITE_PROFILES]?.[sourceSite] || {}
		const defaultProfile = global.Push115.Config.normalizeProcessorProfile(
			input.defaultProcessorProfile || intents[0]?.processorProfile || siteProfile.defaultProcessorProfile,
			'generic',
		)
		const currentCid = pathUtils.normalizeCid(
			input.defaultSavePathCid || intents[0]?.savePathCid || siteProfile.defaultSavePathCid || config[keys.SAVE_PATH_CID],
		) || '0'
		const maxConcurrency = global.Push115.Config.BATCH_CONCURRENCY_MAX || 2
		const concurrency = Math.min(maxConcurrency, Math.max(1, Math.round(Number(input.batchConcurrency || siteProfile.batchConcurrency) || 2)))
		const rootLabel = config[keys.I18N_LOCALE] === 'en-US' ? 'Root' : '根目录'
		const pathOptions = pathUtils.buildPathOptions(config[keys.SAVE_PATH_LIST] || '', rootLabel)
		if (!pathOptions.some(item => item.cid === currentCid)) pathOptions.push({ name: '', cid: currentCid })

		document.getElementById('push115-modal-overlay')?.remove()
		const overlay = document.createElement('div')
		overlay.id = 'push115-modal-overlay'
		overlay.className = 'push115-modal-overlay'
		const modal = document.createElement('div')
		modal.className = 'push115-modal push115-download-confirmation'
		const header = document.createElement('div')
		header.className = 'push115-modal-header'
		const heading = document.createElement('h3')
		heading.className = 'push115-modal-title'
		heading.textContent = '下载任务'
		header.appendChild(heading)
		const body = document.createElement('div')
		body.className = 'push115-modal-body'

		const source = document.createElement('p')
		source.className = 'push115-modal-info'
		source.textContent = `来源网站：${SITE_LABELS[sourceSite] || sourceSite}`
		const textareaLabel = document.createElement('label')
		textareaLabel.className = 'push115-modal-field-label'
		textareaLabel.textContent = '磁链 / ED2K（每行一个，可编辑）'
		const textarea = document.createElement('textarea')
		textarea.className = 'push115-modal-textarea'
		textarea.rows = 7
		textarea.spellcheck = false
		textarea.value = input.initialText !== undefined ? String(input.initialText) : intents.map(intent => intent.url).join('\n')
		textarea.placeholder = 'magnet:?xt=urn:btih:...\ned2k://|file|...'
		const validation = document.createElement('div')
		validation.className = 'push115-validation'

		const profileLabel = document.createElement('label')
		profileLabel.className = 'push115-modal-field-label'
		profileLabel.textContent = '应用规则'
		const processorSelect = document.createElement('select')
		processorSelect.className = 'push115-modal-select'
		for (const name of global.Push115.Config.PROCESSOR_PROFILES) {
			const option = document.createElement('option')
			option.value = name
			option.textContent = PROFILE_LABELS[name]
			option.selected = name === defaultProfile
			processorSelect.appendChild(option)
		}
		const warning = document.createElement('p')
		warning.className = 'push115-profile-warning'

		const pathLabel = document.createElement('label')
		pathLabel.className = 'push115-modal-field-label'
		pathLabel.textContent = '115 保存目录'
		const pathSelect = document.createElement('select')
		pathSelect.className = 'push115-modal-select'
		for (const item of pathOptions) {
			const option = document.createElement('option')
			option.value = item.cid
			option.textContent = pathUtils.formatPathLabel(item, rootLabel)
			option.selected = item.cid === currentCid
			pathSelect.appendChild(option)
		}
		body.append(source, textareaLabel, textarea, validation, profileLabel, processorSelect, warning, pathLabel, pathSelect)

		const footer = document.createElement('div')
		footer.className = 'push115-modal-footer'
		const cancel = document.createElement('button')
		cancel.className = 'push115-modal-btn push115-modal-btn-cancel'
		cancel.type = 'button'
		cancel.textContent = '取消'
		const confirm = document.createElement('button')
		confirm.className = 'push115-modal-btn push115-modal-btn-confirm'
		confirm.type = 'button'
		footer.append(cancel, confirm)
		modal.append(header, body, footer)
		overlay.appendChild(modal)
		document.body.appendChild(overlay)

		const sourceByKey = new Map()
		for (const intent of intents) sourceByKey.set(intentApi.dedupeKey(intent.url), intent)
		confirm.disabled = true
		confirm.textContent = '读取番组目录…'
		const routing = await content.AnimeRouting.create(intents, pathSelect)
		body.appendChild(routing.element)
		let submitting = false

		function intentForRow(row) {
			// Editing trackers keeps identity through BTIH; an unrelated pasted URL
			// must not inherit the first row's series/code/title.
			const original = sourceByKey.get(row.key) || {
				sourceSite, mediaType: 'generic', title: intentApi.extractDisplayName(row.url), code: '', metadata: {},
			}
			const { animeTarget, skipSubmitted, ...metadata } = original.metadata || {}
			return intentApi.create({ ...original, metadata, url: row.url,
				savePathCid: pathSelect.value, processorProfile: processorSelect.value })
		}

		function renderValidation() {
			const rows = intentApi.parseLines(textarea.value)
			const valid = rows.filter(row => row.status === 'valid').length
			const invalid = rows.filter(row => row.status === 'invalid')
			const duplicates = rows.filter(row => row.status === 'duplicate')
			validation.textContent = ''
			const summary = document.createElement('p')
			summary.className = invalid.length ? 'push115-validation-summary error' : 'push115-validation-summary'
			summary.textContent = `有效 ${valid} · 重复 ${duplicates.length} · 非法 ${invalid.length}`
			validation.appendChild(summary)
			for (const row of [...invalid, ...duplicates]) {
				const message = document.createElement('div')
				message.className = `push115-validation-item ${row.status}`
				message.textContent = rowLabel(row)
				validation.appendChild(message)
			}
			confirm.disabled = submitting || valid === 0 || invalid.length > 0
			confirm.textContent = valid > 1 ? `提交 ${valid} 个任务` : '提交下载任务'
			warning.textContent = profileWarning(processorSelect.value, intents)
			routing.update(processorSelect.value, rows.filter(row => row.status === 'valid').map(intentForRow))
			return rows
		}

		textarea.addEventListener('input', renderValidation)
		processorSelect.addEventListener('change', renderValidation)
		cancel.addEventListener('click', () => { if (!submitting) overlay.remove() })
		overlay.addEventListener('click', event => { if (event.target === overlay && !submitting) overlay.remove() })
		confirm.addEventListener('click', async () => {
			const rows = renderValidation()
			if (confirm.disabled) return
			submitting = true
			for (const control of body.querySelectorAll('input, select, textarea')) control.disabled = true
			cancel.disabled = true
			confirm.disabled = true
			confirm.textContent = '确认归档目录…'
			let prepared
			try { prepared = await routing.prepare() }
			catch (error) {
				submitting = false
				for (const control of body.querySelectorAll('input, select, textarea')) control.disabled = false
				cancel.disabled = false
				renderValidation()
				warning.textContent = `目录准备失败：${error.message}`
				return
			}
			const queueItems = rows.filter(row => row.status === 'valid').map(row => {
				const original = intentForRow(row)
				return {
					key: `line-${row.line}`,
					intent: intentApi.create({
						...original,
						...(prepared ? {
							savePathCid: prepared.target.cid,
							metadata: { ...original.metadata, animeTarget: prepared.target, skipSubmitted: prepared.skipSubmitted },
						} : {}),
					}),
				}
			})
			const duplicateItems = rows.filter(row => row.status === 'duplicate').map(row => ({
				key: `duplicate-${row.line}`, title: row.url, url: row.url,
			}))
			const displayItems = [
				...queueItems.map(item => ({ key: item.key, title: item.intent.title, url: item.intent.url })),
				...duplicateItems,
			]
			overlay.remove()
			const progress = new content.BatchProgress.BatchProgress(displayItems)
			for (const item of duplicateItems) progress.update(item.key, 'duplicate', 'duplicate')
			try {
				const result = await global.Push115.SubmissionQueue.submit(queueItems, {
					concurrency,
					onStatus(entry, status) {
						progress.update(entry.key, status, status === 'failed' ? (entry.error?.message || 'failed') : status)
					},
				})
				result.duplicate += duplicateItems.length
				progress.finish(result)
				content.Feedback?.toast(result.failed ? 'warning' : 'success', `提交结束：成功 ${result.success}，失败 ${result.failed}，跳过重复 ${result.duplicate}`)
			} catch (error) {
				content.Feedback?.toast('error', `提交失败：${error?.message || error}`)
			}
		})
		renderValidation()
		textarea.focus()
	}

	content.ConfirmModal = { show }
})(globalThis)
