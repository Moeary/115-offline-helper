;(function (global) {
	'use strict'
	const definitions = global.Push115.Config.SITE_DEFINITIONS
	const processorOptions = [['generic', 'Generic（安全清理，不重命名）'], ['jav', 'JAV（按番号整理）'], ['anime', 'Anime（保留原名）']]
	const listSites = new Set(['nyaa', 'sukebei', 'mikan'])

	function pathOptions(rawPathList, selectedCid, rootLabel = '根目录') {
		const pathUtils = global.Push115.PathUtils
		const options = pathUtils
			? pathUtils.buildPathOptions(rawPathList, rootLabel)
			: [{ name: rootLabel, cid: '0' }]
		const cid = pathUtils?.normalizeCid(selectedCid) || '0'
		if (!options.some(item => item.cid === cid)) options.push({ name: '', cid })
		return { options, cid }
	}

	function select(name, options, value) {
		const element = document.createElement('select')
		element.dataset.field = name
		for (const [optionValue, label] of options) {
			const option = document.createElement('option')
			option.value = optionValue
			option.textContent = label
			option.selected = optionValue === value
			element.appendChild(option)
		}
		return element
	}

	function field(label, control) {
		const wrapper = document.createElement('label')
		wrapper.className = 'push115-site-field'
		const text = document.createElement('span')
		text.textContent = label
		wrapper.append(text, control)
		return wrapper
	}

	function checkboxField(label, name, checked) {
		const control = document.createElement('input')
		control.type = 'checkbox'
		control.dataset.field = name
		control.checked = checked
		return field(label, control)
	}

	function render(rawProfiles, rawPathList = '', rootLabel = '根目录') {
		const profiles = global.Push115.Config.normalizeSiteProfiles(rawProfiles)
		const container = document.getElementById('push115-site-profiles')
		container.textContent = ''
		for (const [siteId, definition] of Object.entries(definitions)) {
			const profile = profiles[siteId]
			const card = document.createElement('section')
			card.className = 'push115-site-profile'
			card.dataset.siteId = siteId
			const heading = document.createElement('label')
			heading.className = 'push115-site-profile-heading'
			const enabled = document.createElement('input')
			enabled.type = 'checkbox'
			enabled.dataset.field = 'enabled'
			enabled.checked = profile.enabled
			const name = document.createElement('strong')
			name.textContent = definition.label
			heading.append(enabled, name)
			const cid = document.createElement('select')
			cid.dataset.field = 'defaultSavePathCid'
			const cidOptions = pathOptions(rawPathList, profile.defaultSavePathCid, rootLabel)
			for (const item of cidOptions.options) {
				const option = document.createElement('option')
				option.value = item.cid
				option.textContent = global.Push115.PathUtils
					? global.Push115.PathUtils.formatPathLabel(item, rootLabel)
					: item.name || rootLabel
				option.selected = item.cid === cidOptions.cid
				cid.appendChild(option)
			}
			card.append(
				heading,
				field('默认 115 保存目录', cid),
				field('默认处理规则', select('defaultProcessorProfile', processorOptions, profile.defaultProcessorProfile)),
				checkboxField('显示行内“发送到115”', 'inlineSendButton', profile.inlineSendButton !== false),
			)
			if (listSites.has(siteId)) {
				const concurrency = document.createElement('input')
				concurrency.type = 'number'
				concurrency.min = '1'
				concurrency.max = '6'
				concurrency.dataset.field = 'batchConcurrency'
				concurrency.value = profile.batchConcurrency
				card.append(
					checkboxField('显示批量选择', 'batchSelection', profile.batchSelection !== false),
					field('批量并发数（1–6）', concurrency),
				)
			}
			container.appendChild(card)
		}
	}

	function collect() {
		const profiles = {}
		for (const card of document.querySelectorAll('.push115-site-profile[data-site-id]')) {
			const siteId = card.dataset.siteId
			const get = name => card.querySelector(`[data-field="${name}"]`)
			profiles[siteId] = {
				enabled: get('enabled').checked,
				defaultSavePathCid: global.Push115.Config.normalizeCid(get('defaultSavePathCid').value, '0'),
				defaultProcessorProfile: get('defaultProcessorProfile').value,
				inlineSendButton: get('inlineSendButton').checked,
			}
			if (listSites.has(siteId)) {
				profiles[siteId].batchSelection = get('batchSelection').checked
				profiles[siteId].batchConcurrency = Number(get('batchConcurrency').value)
			}
		}
		return global.Push115.Config.normalizeSiteProfiles(profiles)
	}

	global.Push115.OptionsSiteProfiles = { render, collect }
})(globalThis)
