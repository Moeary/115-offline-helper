;(function (global) {
	'use strict'
	let currentToast = null

	function toast(type, message, timeout = 3200) {
		currentToast?.remove()
		const element = document.createElement('div')
		element.className = `push115-toast ${type || 'info'}`
		element.textContent = String(message || '')
		document.body.appendChild(element)
		currentToast = element
		if (timeout) setTimeout(() => {
			if (currentToast === element) currentToast = null
			element.remove()
		}, timeout)
		return element
	}

	global.Push115.Content = global.Push115.Content || {}
	global.Push115.Content.Feedback = { toast }
})(globalThis)
