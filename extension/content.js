// Content Script for 115 Offline Helper
// Only handles link detection on web pages. UI is in popup.html.

const CONFIG_KEYS = {
	SAVE_PATH: 'push115_save_path',
	SAVE_PATH_CID: 'push115_save_path_cid',
	SAVE_PATH_LIST: 'push115_save_path_list',
	AUTO_DELETE_SMALL: 'push115_auto_delete_small',
	DELETE_SIZE_THRESHOLD: 'push115_delete_size_threshold',
	AUTO_ORGANIZE: 'push115_auto_organize',
	AUTO_DETECT: 'push115_auto_detect',
	I18N_LOCALE: 'push115_i18n_locale',
	THEME: 'push115_theme',
}

const DEFAULT_CONFIG = {
	[CONFIG_KEYS.SAVE_PATH]: '',
	[CONFIG_KEYS.SAVE_PATH_CID]: '0',
	[CONFIG_KEYS.SAVE_PATH_LIST]: '',
	[CONFIG_KEYS.AUTO_DELETE_SMALL]: false,
	[CONFIG_KEYS.DELETE_SIZE_THRESHOLD]: 100,
	[CONFIG_KEYS.AUTO_ORGANIZE]: false,
	[CONFIG_KEYS.AUTO_DETECT]: false,
	[CONFIG_KEYS.I18N_LOCALE]: 'zh-CN',
	[CONFIG_KEYS.THEME]: 'auto',
}

const I18N_STRINGS = {
	'zh-CN': {
		modal_title: '发现磁力/ED2K 链接',
		modal_detect: '检测到',
		modal_link_type: '链接',
		modal_path: '保存目录:',
		modal_path_hint: '可在弹窗中临时选择本次保存目录',
		modal_cancel: '取消',
		modal_confirm: '推送到 115',
		root_path_name: '根目录',
		pushing: '推送中...',
		push_success: ' 推送成功！',
		push_fail: ' 推送失败: ',
		organizing: '📂 正在整理: ',
		organize_success: ' 整理完成: ',
		organize_fail: ' 整理失败: ',
		cleaning: '🗑️ 正在清理小文件...',
		clean_success: ' 清理完成: ',
		clean_fail: ' 清理失败: ',
		panel_title: '115离线助手',
	},
	'en-US': {
		modal_title: 'Magnet/ED2K Link Detected',
		modal_detect: 'Detected',
		modal_link_type: 'Link',
		modal_path: 'Save Directory:',
		modal_path_hint: 'You can temporarily choose directory for this task',
		modal_cancel: 'Cancel',
		modal_confirm: 'Push to 115',
		root_path_name: 'Root',
		pushing: 'Pushing...',
		push_success: ' Push success!',
		push_fail: ' Push failed: ',
		organizing: '📂 Organizing: ',
		organize_success: ' Organized: ',
		organize_fail: ' Organize failed: ',
		cleaning: '🗑️ Cleaning small files...',
		clean_success: ' Cleaned: ',
		clean_fail: ' Clean failed: ',
		panel_title: '115 Offline Helper',
	},
}

const VIDEO_EXTENSIONS = [
	'.mp4',
	'.mkv',
	'.avi',
	'.wmv',
	'.mov',
	'.flv',
	'.rmvb',
	'.rm',
	'.ts',
	'.m2ts',
	'.webm',
	'.m4v',
	'.3gp',
	'.mpeg',
	'.mpg',
]

function normalizeCode(value) {
	return (value || '')
		.toString()
		.toUpperCase()
		.replace(/\[[^\]]*\]/g, '')
		.replace(/【[^】]*】/g, '')
		.replace(/\([^\)]*\)/g, '')
		.replace(/[^A-Z0-9]+/g, '')
}

function extractVideoCode(rawName) {
	if (!rawName) return ''
	let name = rawName
		.toString()
		.replace(/\.[^.]+$/, '')
		.toUpperCase()

	name = name
		.replace(/\[[^\]]*\]/g, ' ')
		.replace(/【[^】]*】/g, ' ')
		.replace(/\([^\)]*\)/g, ' ')
		.replace(/[@_.]/g, '-')

	name = name.replace(/[^A-Z0-9-]/g, ' ')
	name = name.replace(/[\s-]+/g, '-')

	const fc2Match = name.match(/(FC2-(?:PPV-)?)(\d{5,7})/)
	if (fc2Match) return `${fc2Match[1]}${fc2Match[2]}`

	const invalidPrefixes = [
		'FULL',
		'H264',
		'HEVC',
		'MP4',
		'AVI',
		'MKV',
		'WMV',
		'JPG',
		'PNG',
		'COM',
		'NET',
		'WWW',
		'JAV',
		'HD',
		'FHD',
		'1080P',
		'720P',
		'4K',
		'RESTORE',
		'UNCENSORED',
		'CHINESE',
		'ARCHIVE',
		'XXX',
	]

	const regexGeneral = /\b([A-Z]{2,6})-(\d{2,5})(?:-([A-Z]))?\b/g
	let match
	while ((match = regexGeneral.exec(name)) !== null) {
		const prefix = match[1]
		if (!invalidPrefixes.includes(prefix)) {
			const suffix = match[3] ? `-${match[3]}` : ''
			return `${prefix}-${match[2]}${suffix}`
		}
	}

	const compact = name.replace(/-/g, '')
	const fallbackMatch = compact.match(/([A-Z]{2,6})(\d{2,5})([A-Z])?$/)
	if (fallbackMatch && !invalidPrefixes.includes(fallbackMatch[1])) {
		const suffix = fallbackMatch[3] ? `-${fallbackMatch[3]}` : ''
		return `${fallbackMatch[1]}-${fallbackMatch[2]}${suffix}`
	}

	return ''
}

// ========== 115 API Wrappers ==========

async function getOfflineTasks() {
	const res = await sendMessage('API_REQUEST', {
		url: 'https://115.com/web/lixian/?ct=lixian&ac=task_lists',
		method: 'GET',
	})
	if (res.data?.state) {
		return res.data.tasks || []
	}
	throw new Error('获取任务列表失败')
}

async function getFileList(cid = '0') {
	const res = await sendMessage('API_REQUEST', {
		url: `https://webapi.115.com/files?aid=1&cid=${cid}&o=user_ptime&asc=0&offset=0&show_dir=1&limit=500&snap=0&natsort=1`,
		method: 'GET',
	})
	return res.data // Return full response
}

async function createFolder(parentCid, folderName) {
	const res = await sendMessage('API_REQUEST', {
		url: 'https://webapi.115.com/files/add',
		method: 'POST',
		data: { pid: parentCid, cname: folderName },
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
	})
	return res.data
}

async function moveFile(fid, targetCid) {
	const res = await sendMessage('API_REQUEST', {
		url: 'https://webapi.115.com/files/move',
		method: 'POST',
		data: { pid: targetCid, fid: fid, move_proid: '' },
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
	})
	return res.data
}

async function renameFile(fid, newName) {
	const res = await sendMessage('API_REQUEST', {
		url: 'https://webapi.115.com/files/edit',
		method: 'POST',
		data: { fid, name: newName },
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
	})
	return res.data
}

async function deleteFiles(fids) {
	const ids = Array.isArray(fids) ? fids : [fids]
	const params = new URLSearchParams()
	ids.forEach((fid, index) => {
		params.append(`fid[${index}]`, fid)
	})
	params.append('ignore_warn', '1')

	const res = await sendMessage('API_REQUEST', {
		url: 'https://webapi.115.com/rb/delete',
		method: 'POST',
		data: params.toString(),
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
	})
	return res.data
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function cleanSmallFiles(cid, thresholdMB) {
	const thresholdBytes = thresholdMB * 1024 * 1024
	const allSmallFiles = []

	const scanFolder = async (folderId, depth = 0) => {
		if (depth > 3) return
		const fileList = await getFileList(folderId)
		if (!fileList.data || !Array.isArray(fileList.data)) return

		for (const item of fileList.data) {
			if (!item.sha) {
				// Folder
				const folderCid = item.cid || item.fid
				if (folderCid && folderCid !== folderId) {
					await scanFolder(folderCid, depth + 1)
				}
				continue
			}

			const fileSize = item.size || item.s || 0
			if (fileSize > 0 && fileSize < thresholdBytes) {
				allSmallFiles.push({ fid: item.fid, name: item.n || item.name })
			}
		}
	}

	await scanFolder(cid)

	if (allSmallFiles.length > 0) {
		const fileIds = allSmallFiles.map(f => f.fid)
		// 115 API expects 'fid' to be an array or multiple parameters
		await deleteFiles(fileIds)
	}
	return allSmallFiles.length
}

async function monitorTaskAndOrganize(taskMeta, savePathCid, modalType = 'default') {
	const maxRetries = 120
	let retries = 0
	let taskName = taskMeta?.name || ''
	let taskFileCid = ''

	if (modalType === 'toast') {
		showStickyToast('info', '已推送成功，正在等待离线任务完成，请勿关闭页面...')
	}

	const resolveTaskFolderCid = async () => {
		if (taskFileCid) return taskFileCid
		if (!taskName) return ''

		const list = await getFileList(savePathCid)
		if (!list.data || !Array.isArray(list.data)) return ''

		const normalize = v => (v || '').toString().trim().toLowerCase()
		const taskNameNorm = normalize(taskName)
		const folders = list.data.filter(item => !item.sha)

		const exact = folders.find(item => normalize(item.n || item.name) === taskNameNorm)
		if (exact) return exact.cid || exact.fid

		const fuzzy = folders.find(item => normalize(item.n || item.name).includes(taskNameNorm))
		if (fuzzy) return fuzzy.cid || fuzzy.fid

		return ''
	}

	const ensureUsableCid = async candidateCid => {
		if (!candidateCid) return ''
		try {
			const list = await getFileList(candidateCid)
			if (list?.data && Array.isArray(list.data)) return candidateCid
		} catch (e) {
			console.log('[监控] 目录不可用，准备回退:', candidateCid, e?.message || e)
		}
		return ''
	}

	const processByCid = async (targetCid, currentFolderName = '') => {
		const autoDelete = getConfig(CONFIG_KEYS.AUTO_DELETE_SMALL)
		const autoOrganize = getConfig(CONFIG_KEYS.AUTO_ORGANIZE)
		const messages = []

		if (autoDelete) {
			if (modalType === 'toast') showStickyToast('info', '正在删除小文件，请稍候...')
			const threshold = Number(getConfig(CONFIG_KEYS.DELETE_SIZE_THRESHOLD) || 100)
			const deletedCount = await cleanSmallFiles(targetCid, threshold)
			if (deletedCount > 0) messages.push(`删除 ${deletedCount} 个小文件`)
		}

		if (autoOrganize) {
			if (modalType === 'toast') showStickyToast('info', '正在按文件名整理视频，请稍候...')
			const organizedCount = await organizeVideos(targetCid, currentFolderName)
			if (organizedCount > 0) messages.push(`整理 ${organizedCount} 个视频`)
		}

		if (modalType === 'toast') {
			hideStickyToast()
			if (messages.length > 0) {
				showToast('success', ` ${messages.join('，')}`, 6000)
			} else {
				showToast('warning', '处理完成，但未发现可移动的视频文件（可能仍在系统处理中）', 7000)
			}
		}
	}

	while (retries < maxRetries) {
		try {
			await sleep(10000)
			const tasks = await getOfflineTasks()
			const task = tasks.find(
				t =>
					(taskMeta?.id && (t.info_hash === taskMeta.id || t.name === taskMeta.id)) ||
					(taskName && t.name === taskName),
			)

			if (!task) {
				if (modalType === 'toast' && retries % 3 === 0) {
					showStickyToast('info', `正在等待任务进入列表（已等待 ${Math.floor((retries * 10) / 60)} 分钟）...`)
				}
				retries++
				continue
			}

			if (!taskName && task.name) taskName = task.name
			if (!taskFileCid) {
				taskFileCid = task.file_id || task.fileId || task.dir_id || task.dirId || task.wppath_id || ''
			}

			const isCompleted = task.status === 2 || task.percentDone === 100 || task.state === 1
			if (!isCompleted) {
				if (task.status === -1 || task.state === 2) {
					if (modalType === 'toast') {
						hideStickyToast()
						showToast('error', t('push_fail') + (task.error_msg || 'Unknown error'))
					}
					return
				}
				if (modalType === 'toast' && retries % 2 === 0) {
					const percent = typeof task.percentDone === 'number' ? `${task.percentDone}%` : '进行中'
					showStickyToast('info', `离线任务处理中（${percent}），请等待...`)
				}
				retries++
				continue
			}

			if (modalType === 'toast') {
				showStickyToast('info', '离线任务已完成，正在处理文件...')
			}

			const taskFolderCid = await ensureUsableCid(taskFileCid || (await resolveTaskFolderCid()))
			const targetCid = taskFolderCid || (await ensureUsableCid(savePathCid))
			if (!targetCid) {
				if (modalType === 'toast') {
					hideStickyToast()
					showToast('error', '未找到可处理目录，请稍后重试', 7000)
				}
				return
			}

			// 仅当明确定位到“任务文件夹”时，才把任务名作为当前目录名用于 skip 逻辑
			const organizeFolderName = taskFolderCid ? taskName : ''
			await processByCid(targetCid, organizeFolderName)
			return
		} catch (err) {
			console.error('Monitor error:', err)
			if (modalType === 'toast' && retries % 3 === 0) {
				showStickyToast('warning', '网络波动，正在重试处理...')
			}
			retries++
		}
	}

	// 超时后兜底：直接在保存目录做一次处理
	try {
		if (modalType === 'toast') {
			showStickyToast('warning', '监控超时，正在尝试按保存目录执行一次兜底处理...')
		}
		const fallbackCid = await ensureUsableCid(savePathCid)
		if (fallbackCid) {
			await processByCid(fallbackCid, '')
			return
		}
	} catch (e) {
		console.error('[监控] 兜底处理失败:', e)
	}

	if (modalType === 'toast') {
		hideStickyToast()
		showToast('error', '处理超时，建议稍后在 115 网页手动刷新后重试', 8000)
	}
}

async function organizeVideos(cid, currentFolderName = '') {
	const maxPasses = 8
	let organizedCount = 0
	for (let pass = 0; pass < maxPasses; pass++) {
		const fileList = await getFileList(cid)
		if (!fileList.data || !Array.isArray(fileList.data)) break

		const videoFiles = fileList.data.filter(f => {
			if (!f.sha) return false
			const name = (f.n || f.name || '').toLowerCase()
			return VIDEO_EXTENSIONS.some(ext => name.endsWith(ext))
		})

		if (videoFiles.length === 0) break
		let movedInPass = 0
		let moveFailedInPass = 0

		for (const video of videoFiles) {
			try {
				const fileName = video.n || video.name
				const extMatch = fileName.match(/\.[^.]+$/)
				const ext = extMatch ? extMatch[0] : ''
				const code = extractVideoCode(fileName)
				const folderName = code || fileName.replace(/\.[^.]+$/, '').toUpperCase()
				const currentNameNormalized = normalizeCode(currentFolderName)
				const folderNameNormalized = normalizeCode(folderName)
				const shouldSkipFolder =
					currentNameNormalized &&
					folderNameNormalized &&
					(currentNameNormalized === folderNameNormalized ||
						currentNameNormalized.includes(folderNameNormalized) ||
						folderNameNormalized.includes(currentNameNormalized))

				let canRename = false
				let targetCid
				if (shouldSkipFolder) {
					// 已在匹配目录中，不需要移动；只执行可能的重命名
					canRename = true
				} else {
					const existingFolder = fileList.data.find(f => !f.sha && (f.n || f.name).toUpperCase() === folderName)
					if (existingFolder) {
						targetCid = existingFolder.cid || existingFolder.fid
					} else {
						const createRes = await createFolder(cid, folderName)
						if (createRes.cid || createRes.file_id) {
							targetCid = createRes.cid || createRes.file_id
						} else {
							const updatedList = await getFileList(cid)
							const folder = updatedList.data?.find(f => !f.sha && (f.n || f.name)?.toUpperCase() === folderName)
							targetCid = folder ? folder.cid || folder.fid : ''
						}
					}
					if (targetCid) {
						const moveResult = await moveFile(video.fid, targetCid)
						if (moveResult?.state === true) {
							organizedCount++
							movedInPass++
							canRename = true
						} else {
							moveFailedInPass++
							console.log('[整理] 移动失败，稍后重试:', fileName, moveResult)
						}
					}
				}

				if (code && canRename) {
					const newName = `${code}${ext}`
					if (newName !== fileName) {
						await renameFile(video.fid, newName)
					}
				}

				await sleep(500)
			} catch (err) {
				console.error('Organize error:', err)
			}
		}

		// 有成功移动，立即进行下一轮，处理刷新后的列表
		if (movedInPass > 0) continue

		// 没有移动失败，说明无需重试（可能已在目标目录或无可处理视频）
		if (moveFailedInPass === 0) break

		// 有移动失败，通常是 115 仍在“系统处理中”，等待后再试
		await sleep(15000)
	}
	return organizedCount
}

let configCache = { ...DEFAULT_CONFIG }

function t(key) {
	const locale = configCache[CONFIG_KEYS.I18N_LOCALE] || 'zh-CN'
	const strings = I18N_STRINGS[locale] || I18N_STRINGS['zh-CN']
	return strings[key] || key
}

// Helper to safely send message
function sendMessage(action, details = {}) {
	return new Promise((resolve, reject) => {
		if (!chrome.runtime || !chrome.runtime.sendMessage) {
			reject(new Error('Extension context invalidated. Please refresh the page.'))
			return
		}
		chrome.runtime.sendMessage({ action, details }, response => {
			if (chrome.runtime.lastError) {
				reject(chrome.runtime.lastError)
			} else if (response && response.success) {
				resolve(response)
			} else {
				reject(new Error(response?.error || 'Unknown error'))
			}
		})
	})
}

function getConfig(key) {
	return configCache[key]
}

function getSelectedText() {
	const activeElement = document.activeElement

	if (activeElement) {
		const tagName = activeElement.tagName
		const inputType = (activeElement.type || 'text').toLowerCase()
		const canReadSelection =
			tagName === 'TEXTAREA' || (tagName === 'INPUT' && ['text', 'search', 'url', 'email', 'tel'].includes(inputType))

		if (canReadSelection && typeof activeElement.selectionStart === 'number' && typeof activeElement.selectionEnd === 'number') {
			return activeElement.value.slice(activeElement.selectionStart, activeElement.selectionEnd).trim()
		}
	}

	return window.getSelection()?.toString().trim() || ''
}

function detectOfflineLink(text) {
	if (/^magnet:\?xt=urn:[a-z0-9]+:[a-z0-9]{32,}/i.test(text)) {
		return { url: text, type: 'Magnet' }
	}
	if (/^ed2k:\/\/\|file\|/i.test(text)) {
		return { url: text, type: 'ED2K' }
	}
	return null
}

function getRootLabel() {
	return t('root_path_name')
}

function getSavePathOptions() {
	const listText = getConfig(CONFIG_KEYS.SAVE_PATH_LIST) || ''
	return Push115PathUtils.buildPathOptions(listText, getRootLabel())
}

// Inject modal styles
function injectModalStyles() {
	const style = document.createElement('style')
	style.textContent = `
    .push115-modal-overlay {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.4);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      z-index: 2147483647;
      display: flex; align-items: center; justify-content: center;
      animation: push115Fade 0.2s ease;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
    }
    @keyframes push115Fade { from { opacity: 0; } to { opacity: 1; } }
    .push115-modal {
      background: #fff; border-radius: 16px;
      width: 400px; max-width: 90vw;
      box-shadow: 0 20px 60px rgba(0,0,0,0.2);
      animation: push115Slide 0.25s cubic-bezier(0.4,0,0.2,1);
      overflow: hidden;
    }
    @keyframes push115Slide {
      from { opacity: 0; transform: scale(0.95) translateY(8px); }
      to { opacity: 1; transform: scale(1) translateY(0); }
    }
    .push115-modal-header {
      padding: 16px 20px;
      border-bottom: 1px solid rgba(0,0,0,0.06);
      background: #fafafa;
    }
    .push115-modal-title {
      font-size: 16px; font-weight: 600; color: #1d1d1f; margin: 0;
    }
    .push115-modal-body { padding: 16px 20px; }
    .push115-modal-info {
      font-size: 13px; color: #86868b; margin-bottom: 8px;
    }
    .push115-modal-path-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .push115-modal-path-row .push115-modal-info {
      margin-bottom: 0;
      white-space: nowrap;
      flex: 0 0 auto;
    }
    .push115-modal-link {
      background: #f5f5f7; padding: 10px 12px; border-radius: 8px;
      word-break: break-all; font-size: 11px; color: #1d1d1f;
      max-height: 60px; overflow-y: auto; margin-bottom: 12px;
      font-family: 'SF Mono', Monaco, monospace;
    }
    .push115-modal-select {
      flex: 1 1 auto;
      min-width: 0;
      padding: 8px 10px;
      border: 1px solid rgba(0,0,0,0.12);
      border-radius: 8px;
      font-size: 13px;
      color: #1d1d1f;
      background: #fff;
      outline: none;
    }
    .push115-modal-select:focus {
      border-color: #007AFF;
      box-shadow: 0 0 0 3px rgba(0,122,255,0.12);
    }
    .push115-modal-footer {
      padding: 14px 20px; display: flex; gap: 10px;
      justify-content: flex-end; background: #fafafa;
    }
    .push115-modal-btn {
      padding: 8px 20px; border: none; border-radius: 8px;
      font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.15s;
    }
    .push115-modal-btn-cancel {
      background: rgba(0,0,0,0.05); color: #007AFF;
    }
    .push115-modal-btn-cancel:hover { background: rgba(0,0,0,0.08); }
    .push115-modal-btn-confirm {
      background: #007AFF; color: #fff;
    }
    .push115-modal-btn-confirm:hover { background: #0066d6; }
    .push115-modal-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .push115-toast {
      position: fixed; top: 16px; right: 16px;
      padding: 12px 20px; border-radius: 10px;
      font-size: 13px; font-weight: 500; z-index: 2147483647;
      box-shadow: 0 4px 16px rgba(0,0,0,0.12);
      animation: push115Slide 0.2s ease;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", Arial, sans-serif;
    }
    .push115-toast.success { background: #34c759; color: #fff; }
    .push115-toast.error { background: #ff3b30; color: #fff; }
    .push115-toast.info { background: #0a84ff; color: #fff; }
    .push115-toast.warning { background: #ff9f0a; color: #fff; }
    .push115-toast.push115-sticky {
      display: flex; align-items: center; gap: 10px;
      max-width: 380px; line-height: 1.45;
    }
    .push115-toast-spinner {
      width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,0.35);
      border-top-color: #fff;
      animation: push115Spin 0.8s linear infinite;
      flex: 0 0 auto;
    }
    @keyframes push115Spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `
	document.head.appendChild(style)
}

let stickyToastEl = null

function showToast(type, msg, timeout = 3000) {
	if (stickyToastEl) {
		stickyToastEl.remove()
		stickyToastEl = null
	}
	const existing = document.querySelector('.push115-toast:not(.push115-sticky)')
	if (existing) existing.remove()
	const toast = document.createElement('div')
	toast.className = `push115-toast ${type}`
	toast.textContent = msg
	document.body.appendChild(toast)
	if (timeout) setTimeout(() => toast.remove(), timeout)
}

function showStickyToast(type, msg, withSpinner = true) {
	if (stickyToastEl) stickyToastEl.remove()
	stickyToastEl = document.createElement('div')
	stickyToastEl.className = `push115-toast push115-sticky ${type}`
	if (withSpinner) {
		const spinnerEl = document.createElement('span')
		spinnerEl.className = 'push115-toast-spinner'
		stickyToastEl.appendChild(spinnerEl)
	}
	const msgSpan = document.createElement('span')
	msgSpan.textContent = msg
	stickyToastEl.appendChild(msgSpan)
	document.body.appendChild(stickyToastEl)
}

function hideStickyToast() {
	if (stickyToastEl) {
		stickyToastEl.remove()
		stickyToastEl = null
	}
}

function createConfirmModal(url, type) {
	const existing = document.getElementById('push115-modal-overlay')
	if (existing) existing.remove()

	const currentCid = Push115PathUtils.normalizeCid(getConfig(CONFIG_KEYS.SAVE_PATH_CID)) || '0'
	const options = getSavePathOptions()
	const hasCurrent = options.some(item => item.cid === currentCid)
	const allOptions = hasCurrent ? options : [...options, { name: '', cid: currentCid }]
	const overlay = document.createElement('div')
	overlay.className = 'push115-modal-overlay'
	overlay.id = 'push115-modal-overlay'

	const modal = document.createElement('div')
	modal.className = 'push115-modal'

	// Header
	const header = document.createElement('div')
	header.className = 'push115-modal-header'
	const title = document.createElement('h3')
	title.className = 'push115-modal-title'
	title.textContent = t('modal_title')
	header.appendChild(title)
	modal.appendChild(header)

	// Body
	const body = document.createElement('div')
	body.className = 'push115-modal-body'

	const info1 = document.createElement('div')
	info1.className = 'push115-modal-info'
	info1.textContent = `${t('modal_detect')} `
	const strong = document.createElement('strong')
	strong.textContent = type
	info1.appendChild(strong)
	info1.appendChild(document.createTextNode(` ${t('modal_link_type')}`))
	body.appendChild(info1)

	const linkDiv = document.createElement('div')
	linkDiv.className = 'push115-modal-link'
	linkDiv.textContent = url
	body.appendChild(linkDiv)

	const pathRow = document.createElement('div')
	pathRow.className = 'push115-modal-path-row'
	const pathLabel = document.createElement('div')
	pathLabel.className = 'push115-modal-info'
	pathLabel.textContent = t('modal_path')
	pathRow.appendChild(pathLabel)
	const select = document.createElement('select')
	select.className = 'push115-modal-select'
	select.id = 'push115-modal-save-dir'
	allOptions.forEach(item => {
		const opt = document.createElement('option')
		opt.value = item.cid
		opt.textContent = Push115PathUtils.formatPathLabel(item, getRootLabel())
		if (item.cid === currentCid) opt.selected = true
		select.appendChild(opt)
	})
	pathRow.appendChild(select)
	body.appendChild(pathRow)

	const hintDiv = document.createElement('div')
	hintDiv.className = 'push115-modal-info'
	hintDiv.textContent = t('modal_path_hint')
	body.appendChild(hintDiv)
	modal.appendChild(body)

	// Footer
	const footer = document.createElement('div')
	footer.className = 'push115-modal-footer'
	const cancelBtn = document.createElement('button')
	cancelBtn.className = 'push115-modal-btn push115-modal-btn-cancel'
	cancelBtn.id = 'push115-modal-cancel'
	cancelBtn.textContent = t('modal_cancel')
	footer.appendChild(cancelBtn)
	const confirmBtn = document.createElement('button')
	confirmBtn.className = 'push115-modal-btn push115-modal-btn-confirm'
	confirmBtn.id = 'push115-modal-confirm'
	confirmBtn.textContent = t('modal_confirm')
	footer.appendChild(confirmBtn)
	modal.appendChild(footer)

	overlay.appendChild(modal)

	document.body.appendChild(overlay)

	document.getElementById('push115-modal-cancel').addEventListener('click', () => overlay.remove())
	overlay.addEventListener('click', e => {
		if (e.target === overlay) overlay.remove()
	})
	document.getElementById('push115-modal-confirm').addEventListener('click', async () => {
		const btn = document.getElementById('push115-modal-confirm')
		btn.disabled = true
		btn.textContent = t('pushing')

		try {
			// Get UID
			const userRes = await sendMessage('API_REQUEST', {
				url: 'https://my.115.com/?ct=ajax&ac=nav',
				method: 'GET',
			})
			const uid = userRes.data?.data?.user_id

			// Get Sign
			const tokenRes = await sendMessage('API_REQUEST', {
				url: 'https://115.com/?ct=offline&ac=space',
				method: 'GET',
			})
			const sign = tokenRes.data?.sign
			const time = tokenRes.data?.time

			const savePathCid =
				Push115PathUtils.normalizeCid(document.getElementById('push115-modal-save-dir')?.value) || currentCid || '0'

			const res = await sendMessage('API_REQUEST', {
				url: 'https://115.com/web/lixian/?ct=lixian&ac=add_task_url',
				method: 'POST',
				data: { url, uid, sign, time, wp_path_id: savePathCid, savepath: '' },
				// Let fetch handle Content-Type for URLSearchParams
			})

			if (res.data && res.data.state) {
				overlay.remove()
				showToast('success', t('push_success'))

				// Start monitoring and organizing if feature is enabled
				const autoOrganize = getConfig(CONFIG_KEYS.AUTO_ORGANIZE)
				const autoDelete = getConfig(CONFIG_KEYS.AUTO_DELETE_SMALL)

				if (autoOrganize || autoDelete) {
					monitorTaskAndOrganize(
						{
							id: res.data.info_hash || res.data.name || url,
							name: res.data.name || '',
						},
						savePathCid,
						'toast',
					)
				}
			} else {
				throw new Error(res.data?.error_msg || 'Unknown error')
			}
		} catch (e) {
			btn.disabled = false
			btn.textContent = t('modal_confirm')
			showToast('error', t('push_fail') + e.message)
		}
	})
}

async function init() {
	// Load config
	const items = await chrome.storage.local.get(null)
	configCache = { ...DEFAULT_CONFIG, ...items }

	// Inject styles for modals
	injectModalStyles()

	// Link click listener
	document.addEventListener('click', e => {
		const link = e.target.closest('a')
		if (!link) return

		const href = link.href
		if (href && href.startsWith('magnet:')) {
			e.preventDefault()
			createConfirmModal(href, 'Magnet')
		} else if (href && href.startsWith('ed2k://')) {
			e.preventDefault()
			createConfirmModal(href, 'ED2K')
		}
	})

	// Copy event listener - detect magnet/ed2k links from the current selection
	document.addEventListener('copy', () => {
		if (!getConfig(CONFIG_KEYS.AUTO_DETECT)) return

		const link = detectOfflineLink(getSelectedText())
		if (link) createConfirmModal(link.url, link.type)
	})

	// Listen for config changes
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === 'local') {
			for (const key in changes) {
				if (Object.values(CONFIG_KEYS).includes(key)) {
					configCache[key] = changes[key].newValue
				}
			}
		}
	})
}

// Guard against duplicate injection (registerContentScripts + executeScript)
if (!window.__push115_initialized) {
	window.__push115_initialized = true
	init()
}
