import fs from 'fs'
import path from 'path'
import yaml from 'yaml'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT_PATH = process.cwd()
const CONFIG_PATH = path.join(ROOT_PATH, 'data/xrkconfig/config.yaml')

class XRKConfig {
  constructor() {
    this.config = {}
    this.watchers = new Map()
    this.load()
    this.watch()
  }

  load() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const content = fs.readFileSync(CONFIG_PATH, 'utf8')
        this.config = yaml.parse(content) || {}
        logger.info('[XRKConfig] 配置文件加载成功')
      } else {
        logger.warn('[XRKConfig] 配置文件不存在，使用默认配置')
        this.config = this.getDefaultConfig()
        this.save()
      }
    } catch (e) {
      logger.error('[XRKConfig] 配置文件加载失败:', e)
      this.config = this.getDefaultConfig()
    }
  }

  save() {
    try {
      const dir = path.dirname(CONFIG_PATH)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(CONFIG_PATH, yaml.stringify(this.config), 'utf8')
      logger.info('[XRKConfig] 配置文件保存成功')
    } catch (e) {
      logger.error('[XRKConfig] 配置文件保存失败:', e)
    }
  }

  watch() {
    if (fs.existsSync(CONFIG_PATH)) {
      fs.watchFile(CONFIG_PATH, (curr, prev) => {
        if (curr.mtime !== prev.mtime) {
          logger.info('[XRKConfig] 检测到配置文件变更，重新加载')
          this.load()
          this.emit('change')
        }
      })
    }
  }

  get(key, defaultValue = null) {
    const keys = key.split('.')
    let value = this.config
    
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k]
      } else {
        return defaultValue
      }
    }
    
    return value
  }

  set(key, value) {
    const keys = key.split('.')
    let obj = this.config
    
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i]
      if (!(k in obj) || typeof obj[k] !== 'object') {
        obj[k] = {}
      }
      obj = obj[k]
    }
    
    obj[keys[keys.length - 1]] = value
    this.save()
  }

  on(event, callback) {
    if (!this.watchers.has(event)) {
      this.watchers.set(event, [])
    }
    this.watchers.get(event).push(callback)
  }

  emit(event) {
    if (this.watchers.has(event)) {
      this.watchers.get(event).forEach(callback => callback(this.config))
    }
  }

  get poke() { return this.config.poke }
  get ai() { return this.config.ai }
  get news_groupss() { return this.config.news_groupss }
  get news_pushtime() { return this.config.news_pushtime }
  get peopleai() { return this.config.peopleai }
  get screen_shot_quality() { return this.config.screen_shot_quality }
  get help_priority() { return this.config.help_priority }
  get emoji_filename() { return this.config.emoji_filename }
  get signchecker() { return this.config.signchecker }
  get sharing() { return this.config.sharing }
  get selfcontrol() { return this.config.selfcontrol }
  get coremaster() { return this.config.coremaster }
  get time_groupss() { return this.config.time_groupss }
  get screen_shot_http() { return this.config.screen_shot_http }
  get thumwhiteList() { return this.config.thumwhiteList }
}

export default new XRKConfig()