import cfg from '../../../lib/config/config.js'
import common from '../../../lib/common/common.js'
import xrkcfg from '../components/xrkconfig.js'
import fs from 'fs'
import path from 'path'
import fetch from 'node-fetch'

const ROOT_PATH = process.cwd()
const RESPONSES_PATH = path.join(ROOT_PATH, 'plugins/XRK/config/poke_responses.json')
const IMAGE_DIR = path.join(ROOT_PATH, 'plugins/XRK/resources/emoji/戳一戳表情')
const VOICE_DIR = path.join(ROOT_PATH, 'plugins/XRK/resources/voice')

// 加载响应配置
let responses = {}
try {
  if (fs.existsSync(RESPONSES_PATH)) {
    responses = JSON.parse(fs.readFileSync(RESPONSES_PATH, 'utf8'))
  } else {
    logger.warn('[戳一戳] 响应文件不存在，使用默认响应')
    responses = { relationship: { stranger: ["戳什么戳！"] }, mood: {}, achievements: {} }
  }
} catch (e) {
  logger.error('[戳一戳] 响应文件加载失败:', e)
  responses = { relationship: { stranger: ["戳什么戳！"] }, mood: {}, achievements: {} }
}

// 内存存储实现
const memoryStorage = {
  data: new Map(),
  
  async get(key) {
    const item = this.data.get(key)
    if (item) {
      if (item.expiry && Date.now() > item.expiry) {
        this.data.delete(key)
        return null
      }
      return item.value
    }
    return null
  },
  
  async set(key, value) {
    this.data.set(key, { value, expiry: null })
  },
  
  async setEx(key, seconds, value) {
    this.data.set(key, { 
      value, 
      expiry: Date.now() + (seconds * 1000) 
    })
  },
  
  async incr(key) {
    const val = await this.get(key)
    const newVal = (parseInt(val) || 0) + 1
    await this.set(key, newVal.toString())
    return newVal
  },
  
  async expire(key, seconds) {
    const item = this.data.get(key)
    if (item) {
      item.expiry = Date.now() + (seconds * 1000)
    }
  },
  
  async del(key) {
    this.data.delete(key)
  },
  
  async keys(pattern) {
    const regex = new RegExp(pattern.replace('*', '.*'))
    return Array.from(this.data.keys()).filter(k => regex.test(k))
  },
  
  async ttl(key) {
    const item = this.data.get(key)
    if (item && item.expiry) {
      return Math.floor((item.expiry - Date.now()) / 1000)
    }
    return -1
  }
}

const storage = global.redis || memoryStorage

// Redis键前缀
const REDIS_PREFIX = {
  USER_STATE: 'xrk:poke:user:',
  DAILY_COUNT: 'xrk:poke:daily:',
  MASTER_RECORD: 'xrk:poke:master:',
  COOLDOWN: 'xrk:poke:cd:'
}

// 默认用户状态
const DEFAULT_USER_STATE = {
  intimacy: 0,
  lastInteraction: 0,
  consecutivePokes: 0,
  mood: 'normal',
  moodValue: 50,
  moodExpiry: null,
  lastSpecialEffect: {},
  dailyRewards: [],
  totalPokes: 0,
  achievements: [],
  relationship: 'stranger'
}

export class UniversalPoke extends plugin {
  constructor() {
    super({
      name: '向日葵超级戳一戳',
      dsc: '模块化的戳一戳系统',
      event: 'notice.group.poke',
      priority: xrkcfg.poke?.priority || -5000,
      rule: [{ fnc: 'handlePoke', log: false }]
    })
  }

  /** 初始化模块系统 */
  init() {
    const config = xrkcfg.poke || {}
    const modules = config.modules || {}
    
    this.modules = {
      basic: {
        enabled: modules.basic ?? true,
        execute: this.basicResponse.bind(this)
      },
      mood: {
        enabled: modules.mood ?? true,
        execute: this.moodSystem.bind(this)
      },
      intimacy: {
        enabled: modules.intimacy ?? true,
        execute: this.intimacySystem.bind(this)
      },
      achievement: {
        enabled: modules.achievement ?? true,
        execute: this.achievementSystem.bind(this)
      },
      special: {
        enabled: modules.special ?? true,
        execute: this.specialEffects.bind(this)
      },
      punishment: {
        enabled: modules.punishment ?? true,
        execute: this.punishmentSystem.bind(this)
      },
      pokeback: {
        enabled: modules.pokeback ?? false,
        execute: this.pokebackSystem.bind(this)
      },
      image: {
        enabled: modules.image ?? true,
        execute: this.sendImage.bind(this)
      },
      voice: {
        enabled: modules.voice ?? false,
        execute: this.sendVoice.bind(this)
      },
      master: {
        enabled: modules.master ?? true,
        execute: this.masterProtection.bind(this)
      }
    }

    this.startScheduledTasks()
    
    // 监听配置文件变化
    xrkcfg.on('change', () => {
      logger.info('[戳一戳] 配置已更新，重新初始化模块')
      this.init()
    })
  }

  /** 主处理函数 */
  async handlePoke(e) {
    try {
      // 全局开关
      if (!xrkcfg.poke?.enabled) return false

      // 忽略自己戳自己
      if (e.operator_id === e.target_id) return true

      // 获取身份信息
      const identities = await this.getIdentities(e)
      
      // 检查是否戳主人
      const masterQQs = cfg.masterQQ || []
      const targetIsMaster = masterQQs.includes(String(e.target_id))
      const operatorIsMaster = masterQQs.includes(String(e.operator_id))
      
      // 处理戳主人的情况（非主人戳主人时触发保护）
      if (targetIsMaster && !operatorIsMaster && this.modules.master.enabled) {
        return await this.handleMasterPoke(e, identities)
      }

      // 只处理戳机器人的情况
      if (e.target_id !== e.self_id) return false

      // 检查冷却时间
      if (!await this.checkCooldown(e.operator_id, 'interaction')) {
        return true
      }

      // 获取用户状态
      const userState = await this.getUserState(e.operator_id)
      
      // 更新基础信息
      await this.updateBasicInfo(e, userState)

      // 执行启用的模块
      const moduleResults = await this.executeModules(e, userState, identities)

      // 保存用户状态
      await this.saveUserState(e.operator_id, userState)

      return true
    } catch (err) {
      logger.error('[戳一戳] 处理失败:', err)
      return false
    }
  }

  /** 检查冷却时间 */
  async checkCooldown(userId, type) {
    const cooldowns = xrkcfg.poke?.cooldowns || {}
    const cooldownTime = cooldowns[type] || 3000
    
    const key = `${REDIS_PREFIX.COOLDOWN}${type}:${userId}`
    const lastTime = await storage.get(key)
    
    if (lastTime && Date.now() - parseInt(lastTime) < cooldownTime) {
      return false
    }
    
    await storage.setEx(key, Math.ceil(cooldownTime / 1000), Date.now().toString())
    return true
  }

  /** 获取身份信息 */
  async getIdentities(e) {
    const masterQQs = cfg.masterQQ || []
    const operatorMember = e.group.pickMember(e.operator_id)
    const botMember = e.group.pickMember(e.self_id)
    
    return {
      operatorIsMaster: e.isMaster || masterQQs.includes(String(e.operator_id)),
      targetIsMaster: masterQQs.includes(String(e.target_id)),
      operatorIsOwner: operatorMember?.is_owner || false,
      operatorIsAdmin: operatorMember?.is_admin || false,
      botIsOwner: botMember?.is_owner || false,
      botIsAdmin: botMember?.is_admin || false,
      operatorRole: operatorMember?.is_owner ? 'owner' : 
                   operatorMember?.is_admin ? 'admin' : 'member',
      botRole: botMember?.is_owner ? 'owner' : 
              botMember?.is_admin ? 'admin' : 'member'
    }
  }

  /** 更新基础信息 */
  async updateBasicInfo(e, userState) {
    const now = Date.now()
    
    if (now - userState.lastInteraction < 30000) {
      userState.consecutivePokes++
    } else {
      userState.consecutivePokes = 1
    }

    userState.lastInteraction = now
    userState.totalPokes++
    
    await this.incrementDailyCount(e.operator_id)
  }

  /** 执行模块 */
  async executeModules(e, userState, identities) {
    const results = {}
    const moduleOrder = ['mood', 'intimacy', 'achievement', 'special', 'basic', 'punishment', 'image', 'voice', 'pokeback']
    
    for (const name of moduleOrder) {
      const module = this.modules[name]
      if (module && module.enabled) {
        try {
          results[name] = await module.execute(e, userState, identities)
          
          // 如果某个模块处理成功，有一定概率跳过后续模块
          if (results[name] && Math.random() < 0.3) {
            break
          }
        } catch (err) {
          logger.error(`[戳一戳] 模块${name}执行失败:`, err)
        }
      }
    }
    
    return results
  }

  /** 基础回复模块 */
  async basicResponse(e, userState, identities) {
    const replyPool = this.getReplyPool(userState, identities)
    const replyChance = this.calculateReplyChance(userState, identities)
    
    if (Math.random() < replyChance && replyPool.length > 0) {
      const reply = replyPool[Math.floor(Math.random() * replyPool.length)]
      await e.reply([
        segment.at(e.operator_id),
        `\n${this.formatReply(reply, e, userState)}`
      ])
      return true
    }
    
    return false
  }

  /** 心情系统模块 */
  async moodSystem(e, userState, identities) {
    const moodChangeChance = xrkcfg.poke?.chances?.mood_change || 0.3
    
    if (Math.random() < moodChangeChance) {
      const moodChange = this.calculateMoodChange(userState, identities)
      userState.moodValue = Math.max(0, Math.min(100, userState.moodValue + moodChange))
      
      if (userState.moodValue < 20) {
        userState.mood = 'angry'
      } else if (userState.moodValue < 40) {
        userState.mood = 'sad'
      } else if (userState.moodValue < 60) {
        userState.mood = 'normal'
      } else if (userState.moodValue < 80) {
        userState.mood = 'happy'
      } else {
        userState.mood = 'excited'
      }

      if (Math.abs(moodChange) > 10 && Math.random() < 0.5) {
        const moodReplies = responses.mood[userState.mood]
        if (moodReplies && moodReplies.length > 0) {
          const reply = moodReplies[Math.floor(Math.random() * moodReplies.length)]
          await e.reply([
            segment.at(e.operator_id),
            `\n${this.formatReply(reply, e, userState)}`
          ])
          return true
        }
      }
    }

    return false
  }

  /** 亲密度系统模块 */
  async intimacySystem(e, userState, identities) {
    let intimacyChange = 1
    
    if (identities.operatorIsMaster) intimacyChange += 3
    if (userState.mood === 'happy') intimacyChange += 1
    if (userState.mood === 'angry') intimacyChange -= 1
    if (userState.consecutivePokes > 10) intimacyChange -= 2
    
    userState.intimacy = Math.max(0, userState.intimacy + intimacyChange)
    
    const oldRelationship = userState.relationship
    userState.relationship = this.getRelationshipLevel(userState.intimacy)
    
    if (oldRelationship !== userState.relationship) {
      const upgradeReplies = responses.relationship?.upgrade?.[userState.relationship]
      if (upgradeReplies && upgradeReplies.length > 0) {
        const reply = upgradeReplies[Math.floor(Math.random() * upgradeReplies.length)]
        await e.reply([
          segment.at(e.operator_id),
          `\n🎉 关系升级！\n${this.formatReply(reply, e, userState)}`
        ])
        return true
      }
    }
    
    return false
  }

  /** 成就系统模块 */
  async achievementSystem(e, userState, identities) {
    const achievements = []
    
    const achievementChecks = [
      { id: 'first_poke', condition: userState.totalPokes === 1, name: '初次见面' },
      { id: 'poke_10', condition: userState.totalPokes === 10, name: '戳戳新手' },
      { id: 'poke_100', condition: userState.totalPokes === 100, name: '戳戳达人' },
      { id: 'poke_1000', condition: userState.totalPokes === 1000, name: '戳戳大师' },
      { id: 'poke_5000', condition: userState.totalPokes === 5000, name: '戳戳之神' },
      { id: 'consecutive_10', condition: userState.consecutivePokes === 10, name: '连击达人' },
      { id: 'intimate_100', condition: userState.intimacy >= 100, name: '亲密好友' },
      { id: 'intimate_500', condition: userState.intimacy >= 500, name: '至交挚友' },
      { id: 'mood_master', condition: userState.moodValue >= 90, name: '心情调节大师' }
    ]
    
    for (const check of achievementChecks) {
      if (check.condition && !userState.achievements.includes(check.id)) {
        userState.achievements.push(check.id)
        achievements.push(check)
        
        const achievementReplies = responses.achievements?.[check.id] || responses.achievements?.default || ["成就达成！"]
        const reply = achievementReplies[Math.floor(Math.random() * achievementReplies.length)]
        
        await e.reply([
          segment.at(e.operator_id),
          `\n🏆 获得成就【${check.name}】\n${this.formatReply(reply, e, userState)}`
        ])
        
        return true
      }
    }
    
    return false
  }

  /** 特殊效果模块 */
  async specialEffects(e, userState, identities) {
    const specialChance = xrkcfg.poke?.chances?.special_trigger || 0.15
    
    if (!await this.checkCooldown(e.operator_id, 'special_effect')) {
      return false
    }
    
    if (Math.random() < specialChance) {
      const hour = new Date().getHours()
      let timeEffect = null
      
      if (hour >= 5 && hour < 9) {
        timeEffect = 'morning'
      } else if (hour >= 11 && hour < 14) {
        timeEffect = 'noon'
      } else if (hour >= 17 && hour < 20) {
        timeEffect = 'evening'
      } else if (hour >= 22 || hour < 3) {
        timeEffect = 'night'
      }
      
      if (timeEffect && responses.time_effects?.[timeEffect]) {
        const replies = responses.time_effects[timeEffect]
        if (replies && replies.length > 0) {
          const reply = replies[Math.floor(Math.random() * replies.length)]
          await e.reply([
            segment.at(e.operator_id),
            `\n${this.formatReply(reply, e, userState)}`
          ])
          return true
        }
      }
    }
    
    if (Math.random() < 0.1 && userState.intimacy > 50) {
      const specialEffects = Object.keys(responses.special_effects || {})
      if (specialEffects.length > 0) {
        const effect = specialEffects[Math.floor(Math.random() * specialEffects.length)]
        const replies = responses.special_effects[effect]
        if (replies && replies.length > 0) {
          const reply = replies[Math.floor(Math.random() * replies.length)]
          await e.reply([
            segment.at(e.operator_id),
            `\n✨ ${this.formatReply(reply, e, userState)}`
          ])
          return true
        }
      }
    }
    
    return false
  }

  /** 惩罚系统模块 */
  async punishmentSystem(e, userState, identities) {
    if (userState.consecutivePokes <= 5) return null
    
    const punishmentChance = xrkcfg.poke?.chances?.punishment || 0.3
    
    if (!await this.checkCooldown(e.operator_id, 'punishment')) {
      return false
    }
    
    if (Math.random() < punishmentChance) {
      if (this.canMute(identities) && Math.random() < 0.5) {
        const muteTime = Math.min(60 * userState.consecutivePokes, 1800)
        
        try {
          await e.group.muteMember(e.operator_id, muteTime)
          const muteReplies = responses.punishments?.mute?.success || ["禁言成功！"]
          const reply = muteReplies[Math.floor(Math.random() * muteReplies.length)]
          
          await e.reply([
            segment.at(e.operator_id),
            `\n${this.formatReply(reply, e, userState)}`
          ])
          
          return true
        } catch (err) {
          const failReplies = responses.punishments?.mute?.fail || ["禁言失败..."]
          const reply = failReplies[Math.floor(Math.random() * failReplies.length)]
          
          await e.reply([
            segment.at(e.operator_id),
            `\n${this.formatReply(reply, e, userState)}`
          ])
        }
      }
      
      if (Math.random() < 0.5) {
        const reduction = Math.min(userState.consecutivePokes * 2, 20)
        userState.intimacy = Math.max(0, userState.intimacy - reduction)
        
        const reductionReplies = responses.punishments?.intimacy_reduction || ["亲密度下降了..."]
        const reply = reductionReplies[Math.floor(Math.random() * reductionReplies.length)]
        
        await e.reply([
          segment.at(e.operator_id),
          `\n${this.formatReply(reply.replace('{reduction}', reduction), e, userState)}`
        ])
        
        return true
      }
    }
    
    userState.moodValue = Math.max(0, userState.moodValue - userState.consecutivePokes * 2)
    
    return false
  }

  /** 反戳系统模块 */
  async pokebackSystem(e, userState, identities) {
    if (!xrkcfg.poke?.pokeback_enabled) return false
    
    let pokebackChance = 0.3
    
    if (userState.mood === 'angry') pokebackChance += 0.3
    if (userState.consecutivePokes > 5) pokebackChance += 0.2
    if (identities.operatorIsMaster) pokebackChance -= 0.2
    
    if (Math.random() < pokebackChance) {
      const pokebackReplies = responses.pokeback?.[userState.mood] || responses.pokeback?.normal || ["戳回去！"]
      const reply = pokebackReplies[Math.floor(Math.random() * pokebackReplies.length)]
      
      await e.reply([
        segment.at(e.operator_id),
        `\n${this.formatReply(reply, e, userState)}`
      ])
      
      const pokeCount = Math.min(Math.floor(userState.consecutivePokes / 2), 5)
      for (let i = 0; i < pokeCount; i++) {
        await common.sleep(1000)
        await this.pokeMember(e, e.operator_id)
      }
      
      return true
    }
    
    return false
  }

  /** 发送图片模块 */
  async sendImage(e, userState, identities) {
    let imageChance = xrkcfg.poke?.image_chance || 0.3
    
    if (userState.mood === 'happy') imageChance += 0.1
    if (userState.intimacy > 100) imageChance += 0.1
    
    if (Math.random() < imageChance) {
      try {
        if (fs.existsSync(IMAGE_DIR)) {
          const files = fs.readdirSync(IMAGE_DIR).filter(file =>
            /\.(jpg|jpeg|png|gif|webp)$/i.test(file)
          )
          
          if (files.length > 0) {
            const randomFile = files[Math.floor(Math.random() * files.length)]
            await e.reply(segment.image(`file://${path.join(IMAGE_DIR, randomFile)}`))
            return true
          }
        }
      } catch (err) {
        logger.error('[戳一戳] 发送图片失败:', err)
      }
    }
    
    return false
  }

  /** 发送语音模块 */
  async sendVoice(e, userState, identities) {
    let voiceChance = xrkcfg.poke?.voice_chance || 0.2
    
    if (userState.mood === 'excited') voiceChance += 0.1
    if (userState.intimacy > 200) voiceChance += 0.1
    
    if (Math.random() < voiceChance) {
      try {
        if (fs.existsSync(VOICE_DIR)) {
          const files = fs.readdirSync(VOICE_DIR).filter(file =>
            /\.(mp3|wav|ogg|silk|amr)$/i.test(file)
          )
          
          if (files.length > 0) {
            const randomFile = files[Math.floor(Math.random() * files.length)]
            await e.reply(segment.record(`file://${path.join(VOICE_DIR, randomFile)}`))
            return true
          }
        }
      } catch (err) {
        logger.error('[戳一戳] 发送语音失败:', err)
      }
    }
    
    return false
  }

  /** 处理戳主人 */
  async handleMasterPoke(e, identities) {
    const record = await this.getMasterPokeRecord(e.group_id, e.operator_id)
    record.count++
    await this.saveMasterPokeRecord(e.group_id, e.operator_id, record)
    
    let replyPool = responses.master_protection?.normal || ["不许戳主人！"]
    
    if (identities.operatorIsOwner) {
      replyPool = responses.master_protection?.owner_warning || replyPool
    } else if (identities.operatorIsAdmin) {
      replyPool = responses.master_protection?.admin_warning || replyPool
    } else if (record.count > 5) {
      replyPool = responses.master_protection?.repeat_offender || replyPool
    }
    
    const reply = replyPool[Math.floor(Math.random() * replyPool.length)]
    
    await e.reply([
      segment.at(e.operator_id),
      `\n${reply.replace('{count}', record.count)}`
    ])
    
    if (xrkcfg.poke?.master_image) {
      try {
        const response = await fetch("https://api.xingdream.top/API/poke.php")
        const data = await response.json()
        if (data?.status == 200 && data?.link) {
          await e.reply(segment.image(data.link))
        }
      } catch (err) {
        logger.error('[戳主人] 图片获取失败:', err)
      }
    }
    
    if (xrkcfg.poke?.master_punishment) {
      await this.punishMasterPoker(e, identities, record)
    }
    
    return true
  }

  /** 惩罚戳主人的人 */
  async punishMasterPoker(e, identities, record) {
    let punishLevel = 1
    if (record.count > 3) punishLevel = 2
    if (record.count > 10) punishLevel = 3
    
    if (this.canMute(identities) && Math.random() < 0.5 * punishLevel) {
      const muteTime = Math.min(300 * punishLevel * record.count, 86400)
      
      try {
        await e.group.muteMember(e.operator_id, muteTime)
        const muteReplies = responses.master_protection?.punishments?.mute || ["禁言！"]
        const reply = muteReplies[Math.floor(Math.random() * muteReplies.length)]
        await e.reply(reply)
      } catch (err) {
        const failReplies = responses.master_protection?.punishments?.mute_fail || ["禁言失败..."]
        const reply = failReplies[Math.floor(Math.random() * failReplies.length)]
        await e.reply(reply)
      }
    }
    
    if (xrkcfg.poke?.pokeback_enabled && Math.random() < 0.7) {
      const pokeReplies = responses.master_protection?.punishments?.poke || ["反击！"]
      const reply = pokeReplies[Math.floor(Math.random() * pokeReplies.length)]
      await e.reply(reply)
      
      const pokeCount = Math.min(5 * punishLevel, 20)
      for (let i = 0; i < pokeCount; i++) {
        await common.sleep(800)
        await this.pokeMember(e, e.operator_id)
      }
    }
  }

  // ========== 工具函数 ==========

  /** 获取回复池 */
  getReplyPool(userState, identities) {
    let pool = []
    
    const relationshipReplies = responses.relationship?.[userState.relationship] || responses.relationship?.stranger || []
    pool = [...relationshipReplies]
    
    if (responses.mood?.[userState.mood]) {
      pool = [...pool, ...responses.mood[userState.mood]]
    }
    
    if (identities.operatorIsMaster && responses.special_identity?.master) {
      pool = [...pool, ...responses.special_identity.master]
    }
    
    return pool
  }

  /** 计算回复概率 */
  calculateReplyChance(userState, identities) {
    let chance = 0.6
    
    chance += Math.min(0.2, userState.intimacy / 1000)
    
    if (userState.mood === 'happy') chance += 0.1
    if (userState.mood === 'angry') chance -= 0.2
    
    if (userState.consecutivePokes > 5) chance -= 0.3
    
    if (identities.operatorIsMaster) chance += 0.2
    
    return Math.max(0.1, Math.min(1, chance))
  }

  /** 计算心情变化 */
  calculateMoodChange(userState, identities) {
    let change = 0
    
    if (userState.consecutivePokes <= 3) {
      change = Math.random() * 5
    } else if (userState.consecutivePokes <= 10) {
      change = -Math.random() * 5
    } else {
      change = -Math.random() * 10
    }
    
    if (identities.operatorIsMaster) change += 5
    
    const hour = new Date().getHours()
    if (hour >= 22 || hour < 6) change -= 3
    
    return change
  }

  /** 获取关系等级 */
  getRelationshipLevel(intimacy) {
    if (intimacy < 10) return 'stranger'
    if (intimacy < 50) return 'acquaintance'
    if (intimacy < 100) return 'friend'
    if (intimacy < 300) return 'close_friend'
    if (intimacy < 500) return 'best_friend'
    if (intimacy < 1000) return 'intimate'
    return 'soulmate'
  }

  /** 格式化回复 */
  formatReply(reply, e, userState) {
    const nickname = e.sender?.card || e.sender?.nickname || '你'
    
    return reply
      .replace(/{name}/g, nickname)
      .replace(/{intimacy}/g, userState.intimacy)
      .replace(/{mood}/g, this.getMoodName(userState.mood))
      .replace(/{consecutive}/g, userState.consecutivePokes)
      .replace(/{total}/g, userState.totalPokes)
      .replace(/{count}/g, userState.consecutivePokes)
  }

  /** 获取心情名称 */
  getMoodName(mood) {
    const moodNames = {
      angry: '生气',
      sad: '难过',
      normal: '普通',
      happy: '开心',
      excited: '兴奋'
    }
    return moodNames[mood] || mood
  }

  /** 判断是否可以禁言 */
  canMute(identities) {
    if (identities.botIsOwner) return true
    
    if (identities.botIsAdmin) {
      if (identities.operatorIsOwner || identities.operatorIsAdmin) return false
      return true
    }
    
    return false
  }

  /** 戳群成员 */
  async pokeMember(e, userId) {
    if (!xrkcfg.poke?.pokeback_enabled) return
    
    try {
      if (e.group?.pokeMember) {
        await e.group.pokeMember(userId)
      } else {
        await e.reply([
          segment.at(userId),
          '\n👉 戳你一下！'
        ])
      }
    } catch (err) {
      logger.error('[戳一戳] 戳成员失败:', err)
    }
  }

  /** 定时任务 */
  startScheduledTasks() {
    // 每日重置
    setInterval(() => {
      const hour = new Date().getHours()
      if (hour === 0) {
        this.resetDailyData()
      }
    }, 3600000)
    
    // 清理过期数据
    setInterval(() => {
      this.cleanExpiredData()
    }, 3600000)
  }

  /** 重置每日数据 */
  async resetDailyData() {
    try {
      const keys = await storage.keys(`${REDIS_PREFIX.DAILY_COUNT}*`)
      for (const key of keys) {
        await storage.del(key)
      }
      logger.info('[戳一戳] 每日数据已重置')
    } catch (err) {
      logger.error('[戳一戳] 重置每日数据失败:', err)
    }
  }

  /** 清理过期数据 */
  async cleanExpiredData() {
    try {
      const patterns = [
        `${REDIS_PREFIX.USER_STATE}*`,
        `${REDIS_PREFIX.MASTER_RECORD}*`,
        `${REDIS_PREFIX.COOLDOWN}*`
      ]
      
      for (const pattern of patterns) {
        const keys = await storage.keys(pattern)
        for (const key of keys) {
          const ttl = await storage.ttl(key)
          if (ttl === 0) {
            await storage.del(key)
          }
        }
      }
    } catch (err) {
      logger.error('[戳一戳] 清理过期数据失败:', err)
    }
  }

  // ========== Storage 操作 ==========

  /** 获取用户状态 */
  async getUserState(userId) {
    try {
      const key = `${REDIS_PREFIX.USER_STATE}${userId}`
      const data = await storage.get(key)
      
      if (data) {
        const state = JSON.parse(data)
        return { ...DEFAULT_USER_STATE, ...state }
      }
      
      return { ...DEFAULT_USER_STATE }
    } catch (err) {
      logger.error('[戳一戳] 获取用户状态失败:', err)
      return { ...DEFAULT_USER_STATE }
    }
  }

  /** 保存用户状态 */
  async saveUserState(userId, userState) {
    try {
      const key = `${REDIS_PREFIX.USER_STATE}${userId}`
      await storage.setEx(key, 604800, JSON.stringify(userState))
    } catch (err) {
      logger.error('[戳一戳] 保存用户状态失败:', err)
    }
  }

  /** 获取每日戳戳次数 */
  async getDailyCount(userId) {
    try {
      const key = `${REDIS_PREFIX.DAILY_COUNT}${userId}`
      const count = await storage.get(key)
      return count ? parseInt(count) : 0
    } catch (err) {
      logger.error('[戳一戳] 获取每日次数失败:', err)
      return 0
    }
  }

  /** 增加每日戳戳次数 */
  async incrementDailyCount(userId) {
    try {
      const key = `${REDIS_PREFIX.DAILY_COUNT}${userId}`
      await storage.incr(key)
      
      const now = new Date()
      const endOfDay = new Date(now)
      endOfDay.setHours(23, 59, 59, 999)
      const ttl = Math.floor((endOfDay - now) / 1000)
      await storage.expire(key, ttl)
    } catch (err) {
      logger.error('[戳一戳] 增加每日次数失败:', err)
    }
  }

  /** 获取戳主人记录 */
  async getMasterPokeRecord(groupId, userId) {
    try {
      const key = `${REDIS_PREFIX.MASTER_RECORD}${groupId}:${userId}`
      const data = await storage.get(key)
      
      if (data) {
        return JSON.parse(data)
      }
      
      return { count: 0, lastPoke: Date.now() }
    } catch (err) {
      logger.error('[戳一戳] 获取主人戳戳记录失败:', err)
      return { count: 0, lastPoke: Date.now() }
    }
  }

  /** 保存戳主人记录 */
  async saveMasterPokeRecord(groupId, userId, record) {
    try {
      const key = `${REDIS_PREFIX.MASTER_RECORD}${groupId}:${userId}`
      record.lastPoke = Date.now()
      await storage.setEx(key, 86400, JSON.stringify(record))
    } catch (err) {
      logger.error('[戳一戳] 保存主人戳戳记录失败:', err)
    }
  }
}