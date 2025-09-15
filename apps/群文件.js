import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import fetch from 'node-fetch'
import { 制作聊天记录 } from '../../../lib/util.js';

const fileCache = {}

export class GroupFileManager extends plugin {
  constructor() {
    super({
      name: 'group-file-manager',
      dsc: 'QQ群文件管理器，支持查看、下载、删除群文件',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: '^#?(群文件|查看群文件|文件列表)$', fnc: 'listFiles', permission: 'all' },
        { reg: '^#?下载js([0-9]+|.+)$', fnc: 'downloadFile', permission: 'master' },
        { reg: '^#?删除群文件([0-9 ]+|[^ ]+.*)$', fnc: 'deleteFile', permission: 'admin' }
      ]
    })
  }

  /** 查看群文件 */
  async listFiles(e) {
    if (!e.isGroup) return this.reply('此功能仅支持群聊使用~')
    try {
      const files = await e.group.fs.ls()
      if (!files || (!files.folders?.length && !files.files?.length)) return this.reply('群文件列表为空~')

      const allFiles = []
      const collectFiles = async (folderId, folderName = '') => {
        const folderFiles = await e.group.fs.ls(folderId)
        if (folderFiles.files) {
          folderFiles.files.forEach(file => {
            allFiles.push({ ...file, folderName })
          })
        }
        if (folderFiles.folders) {
          for (const folder of folderFiles.folders) {
            await collectFiles(folder.folder_id, folderName ? `${folderName}/${folder.folder_name}` : folder.folder_name)
          }
        }
      }

      if (files.files) {
        files.files.forEach(file => {
          allFiles.push({ ...file, folderName: '' })
        })
      }

      if (files.folders) {
        for (const folder of files.folders) {
          await collectFiles(folder.folder_id, folder.folder_name)
        }
      }

      fileCache[e.group_id] = allFiles

      const messages = ['【群文件列表】']
      allFiles.forEach((file, index) => {
        const fileName = file.folderName ? `${file.folderName}/${file.file_name}` : file.file_name
        messages.push(`${index + 1}. ${fileName} (${this.formatFileSize(file.file_size)})`)
      })

      await 制作聊天记录(e, messages, '群文件列表', ['葵崽驾到，通通闪开'])
      return true
    } catch (err) {
      logger.error(`获取群文件失败: ${err}`)
      return this.reply('获取群文件列表失败，请稍后再试')
    }
  }

  /** 下载群文件 */
  async downloadFile(e) {
    if (!e.isGroup) return this.reply('此功能仅支持群聊使用~')
    const fileIdentifier = e.msg.replace(/^#?下载js/, '').trim()
    if (!fileIdentifier) return this.reply('请指定要下载的文件序号')

    try {
      const cache = fileCache[e.group_id] || (await this.listFiles(e) && fileCache[e.group_id])
      if (!cache?.length) return this.reply('群文件列表为空，无法下载')

      const index = parseInt(fileIdentifier) - 1
      if (isNaN(index) || index < 0 || index >= cache.length) return this.reply(`无效的文件序号"${fileIdentifier}"`)

      const file = cache[index]
      await this.reply(`正在下载"${file.file_name}"，请稍候...`)

      const url = await e.group.fs.download(file.file_id, file.busid)
      if (!url?.url) return this.reply('获取下载链接失败')

      const downloadPath = path.join(process.cwd(), 'plugins', 'example', file.file_name)
      await fs.promises.mkdir(path.dirname(downloadPath), { recursive: true })
      const response = await fetch(url.url)
      if (!response.ok) throw new Error('文件下载失败')
      await pipeline(response.body, fs.createWriteStream(downloadPath))

      return this.reply(`文件"${file.file_name}"已下载到本地目录`)
    } catch (err) {
      logger.error(`下载文件失败: ${err}`)
      return this.reply('下载文件失败，请稍后再试')
    }
  }

  /** 删除群文件 */
  async deleteFile(e) {
    if (!e.isGroup) return this.reply('此功能仅支持群聊使用~')
    const fileIdentifiers = e.msg.replace(/^#?删除群文件/, '').trim().split(/\s+/)
    if (!fileIdentifiers.length || fileIdentifiers[0] === '') return this.reply('请指定要删除的文件序号')

    try {
      const cache = fileCache[e.group_id] || (await this.listFiles(e) && fileCache[e.group_id])
      if (!cache?.length) return this.reply('群文件列表为空，无法删除')

      const indices = fileIdentifiers
        .map(id => parseInt(id) - 1)
        .filter(index => !isNaN(index) && index >= 0 && index < cache.length)

      if (!indices.length) return this.reply('未找到任何有效的文件序号')

      const filesToDelete = indices.map(index => cache[index])

      // 执行删除
      await Promise.all(filesToDelete.map(file => e.group.fs.rm(file.file_id, file.busid)))
      await this.listFiles(e) // 刷新文件列表
      return this.reply(`已删除${filesToDelete.length}个文件`)
    } catch (err) {
      logger.error(`删除文件失败: ${err}`)
      return this.reply('删除文件失败，请稍后再试')
    }
  }

  /** 格式化文件大小 */
  formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }
}