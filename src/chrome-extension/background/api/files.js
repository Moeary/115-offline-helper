;(function (global) {
	'use strict'
	const client = global.Push115.Background.Client

	function operationSucceeded(result) {
		return result?.state === true || result?.state === 1 || result?.state === '1'
	}

	async function list(cid = '0') {
		return client.data({
			url: `https://webapi.115.com/files?aid=1&cid=${cid}&o=user_ptime&asc=0&offset=0&show_dir=1&limit=500&snap=0&natsort=1`,
			method: 'GET',
		})
	}

	async function createFolder(parentCid, folderName) {
		return client.data({
			url: 'https://webapi.115.com/files/add', method: 'POST',
			data: { pid: parentCid, cname: folderName },
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		})
	}

	async function move(fid, targetCid) {
		return client.data({
			url: 'https://webapi.115.com/files/move', method: 'POST',
			data: { pid: targetCid, fid, move_proid: '' },
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		})
	}

	async function rename(fid, newName) {
		return client.data({
			url: 'https://webapi.115.com/files/edit', method: 'POST', data: { fid, name: newName },
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		})
	}

	async function remove(fids) {
		const ids = (Array.isArray(fids) ? fids : [fids]).filter(Boolean)
		if (ids.length === 0) return { state: true }
		const params = new URLSearchParams()
		ids.forEach((fid, index) => params.append(`fid[${index}]`, fid))
		params.append('ignore_warn', '1')
		return client.data({
			url: 'https://webapi.115.com/rb/delete', method: 'POST', data: params.toString(),
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		})
	}

	global.Push115.Background.FilesApi = { list, createFolder, move, rename, remove, operationSucceeded }
})(globalThis)
