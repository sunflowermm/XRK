import fs from 'fs'
import path from 'path'
import yaml from 'yaml'
import chokidar from 'chokidar'

class XRKConfig {
  constructor() {
    this.configPath = path.join(process.cwd(), 'data/xrkconfig/config.yaml')
    this.config = {}
    this.watchers = new Map()
    this.callbacks = new Set()
    
    this.loadConfig()
    this.watchConfig()
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const content = fs.readFileSync(this.configPath, 'utf8')
        this.config = yaml.parse(content) || {}
        logger.info('[XRKConfig] 配置文件加载成功')
      } else {
        logger.warn('[XRKConfig] 配置文件不存在，使用默认配置')
        this.config = this.getDefaultConfig()
        this.saveConfig()
      }
    } catch (e) {
      logger.error('[XRKConfig] 配置文件加载失败:', e)
      this.config = this.getDefaultConfig()
    }
    this.callbacks.forEach(callback => callback(this.config))
  }

  saveConfig() {
    try {
      const dir = path.dirname(this.configPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(this.configPath, yaml.stringify(this.config))
      logger.info('[XRKConfig] 配置文件保存成功')
    } catch (e) {
      logger.error('[XRKConfig] 配置文件保存失败:', e)
    }
  }

  watchConfig() {
    if (fs.existsSync(this.configPath)) {
      const watcher = chokidar.watch(this.configPath, {
        persistent: true,
        ignoreInitial: true
      })
      
      watcher.on('change', () => {
        logger.info('[XRKConfig] 配置文件变更，重新加载')
        this.loadConfig()
      })
      
      this.watchers.set('main', watcher)
    }
  }

  // 注册配置变更回调
  onConfigChange(callback) {
    this.callbacks.add(callback)
    return () => this.callbacks.delete(callback)
  }

  // 获取配置项
  get(key, defaultValue) {
    const keys = key.split('.')
    let value = this.config
    
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k]
      } else {
        return defaultValue
      }
    }
    
    return value ?? defaultValue
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
    this.saveConfig()
  }

  get poke() {
    return this.config.poke || {}
  }
  
  get ai() {
    return this.config.ai || {}
  }
  
  get news_groupss() {
    return this.config.news_groupss || []
  }
  
  get news_pushtime() {
    return this.config.news_pushtime || 8
  }
}

const xrkconfig = new XRKConfig()
const xrkcfg = new Proxy(xrkconfig, {
  get(target, prop) {
    if (prop in target.config) {
      return target.config[prop]
    }
    if (typeof target[prop] === 'function') {
      return target[prop].bind(target)
    }
    return target[prop]
  },
  set(target, prop, value) {
    target.config[prop] = value
    target.saveConfig()
    return true
  }
})

export default xrkcfg