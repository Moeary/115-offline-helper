;(function (global) {
	'use strict'

	function send(action, details = {}) {
		return new Promise((resolve, reject) => {
			if (!chrome.runtime?.sendMessage) {
				reject(new Error('扩展上下文已失效，请刷新页面'))
				return
			}
			chrome.runtime.sendMessage({ action, details }, response => {
				if (chrome.runtime.lastError) reject(chrome.runtime.lastError)
				else if (response?.success) resolve(response)
				else reject(new Error(response?.error || 'Unknown error'))
			})
		})
	}

	global.Push115 = global.Push115 || {}
	global.Push115.Messaging = { send }
})(typeof globalThis !== 'undefined' ? globalThis : self)
