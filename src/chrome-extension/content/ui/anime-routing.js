;(function (global) {
	'use strict'
	const content = global.Push115.Content = global.Push115.Content || {}
	const seriesApi = global.Push115.AnimeSeries

	async function create(intents, pathSelect) {
		const series = seriesApi.common(intents)
		const element = document.createElement('section')
		element.className = 'push115-anime-routing'
		element.hidden = true
		if (!series) return { element, update() {}, async prepare() { return null } }
		let binding = null
		let loadError = ''
		try { binding = (await global.Push115.Messaging.send('GET_ANIME_SERIES', { key: series.key })).binding }
		catch (error) { loadError = error.message }
		const initialCid = pathSelect.value
		if (binding && ![...pathSelect.options].some(option => option.value === binding.cid)) {
			pathSelect.add(new Option(`${binding.name}（本番已绑定）`, binding.cid))
		}
		const label = document.createElement('label')
		label.className = 'push115-modal-field-label'
		label.textContent = `番组归档：${series.title}`
		const mode = document.createElement('select')
		mode.className = 'push115-modal-select'
		mode.setAttribute('aria-label', '番组归档方式')
		if (binding) mode.add(new Option('继续使用本番已绑定的目录', 'reuse'))
		mode.add(new Option('在所选目录下建立 / 复用一层番组目录', 'create'))
		mode.add(new Option('直接归档到所选目录，并记住本番', 'bind'))
		mode.add(new Option('仅本次普通 Anime，不使用番组目录记忆', 'plain'))
		mode.value = binding ? 'reuse' : 'create'
		const name = document.createElement('input')
		name.type = 'text'
		name.className = 'push115-modal-select'
		name.setAttribute('aria-label', '番组文件夹名称')
		name.value = seriesApi.folderName(series.title)
		name.maxLength = 120
		const skipLabel = document.createElement('label')
		skipLabel.className = 'push115-modal-info'
		const skip = document.createElement('input')
		skip.type = 'checkbox'
		skip.checked = true
		skipLabel.append(skip, ' 跳过本番已提交的相同磁链（可取消以重新下载）')
		const preview = document.createElement('p')
		preview.className = 'push115-profile-warning'
		element.append(label, mode, name, skipLabel, preview)
		let applicable = false
		let lastMode = ''
		function render() {
			const grouping = applicable && mode.value !== 'plain'
			pathSelect.disabled = grouping && mode.value === 'reuse'
			if (pathSelect.disabled) pathSelect.value = binding.cid
			else if (lastMode === 'reuse') pathSelect.value = initialCid
			lastMode = applicable ? mode.value : ''
			name.hidden = mode.value !== 'create'
			skipLabel.hidden = mode.value === 'plain'
			const selected = pathSelect.selectedOptions[0]?.textContent || pathSelect.value
			const target = mode.value === 'create' ? `${selected} / ${name.value}` : selected
			const submitted = Object.values(binding?.submissions || {}).filter(item => item.cid === binding.cid).length
			preview.textContent = loadError
				? `读取本番目录失败：${loadError}。可重新打开确认窗口，或选择普通 Anime。`
				: mode.value === 'plain' ? '按普通 Anime 规则处理本次提交。'
				: `目标：${target} / 原视频文件名。单集、合集、以后补集均归入这里，文件保留原名；移动后回收空任务目录。${submitted ? ` 本番在此目录已提交 ${submitted} 个资源（不代表已下载集数）。` : ''}`
		}
		mode.addEventListener('change', render)
		pathSelect.addEventListener('change', render)
		name.addEventListener('input', render)
		function update(profile, currentIntents) {
			applicable = profile === 'anime' && seriesApi.common(currentIntents)?.key === series.key
			element.hidden = !applicable
			render()
		}
		async function prepare() {
			if (!applicable || mode.value === 'plain') return null
			if (loadError) throw new Error(loadError)
			const response = await global.Push115.Messaging.send('PREPARE_ANIME_SERIES', {
				series, mode: mode.value, cid: pathSelect.value,
				folderName: name.value, expectedCid: binding?.cid || '',
			})
			// If submission is retried in this still-open dialog, retain the prepared binding.
			binding = { ...series, ...response.target, submissions: binding?.submissions || {} }
			return { target: response.target, skipSubmitted: skip.checked }
		}
		return { element, update, prepare }
	}
	content.AnimeRouting = { create }
})(globalThis)
