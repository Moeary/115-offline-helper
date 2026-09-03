;(function (global) {
	'use strict'

	async function request(details = {}) {
		const { url, method = 'GET', data = null, headers = {} } = details
		if (!url) throw new Error('缺少请求地址')
		const normalizedMethod = String(method).toUpperCase()
		if (global.Push115.Background.Auth.is115Host(url)) {
			await global.Push115.Background.Auth.restorePersistedCookieIfMissing()
		}

		let body
		if (!['GET', 'HEAD'].includes(normalizedMethod) && data) {
			if (typeof data === 'string') body = data
			else {
				const params = new URLSearchParams()
				for (const key in data) params.append(key, data[key])
				body = params
			}
		}

		const response = await fetch(url, {
			method: normalizedMethod,
			headers: { ...headers },
			body,
			credentials: 'include',
		})
		const responseText = await response.text()
		let responseData
		try {
			responseData = JSON.parse(responseText)
		} catch (error) {
			responseData = responseText
		}

		if (
			responseData?.state === 1 && responseData?.data?.cookie &&
			typeof url === 'string' && url.includes('/login/qrcode/')
		) {
			await global.Push115.Background.Auth.persistCookieToStorageAndJar(responseData.data.cookie)
		}

		return { data: responseData, status: response.status, statusText: response.statusText }
	}

	async function data(details = {}) {
		return (await request(details)).data
	}

	global.Push115.Background.Client = { request, data }
})(globalThis)
