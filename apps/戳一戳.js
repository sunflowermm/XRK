import cfg from '../../../lib/config/config.js'
import common from '../../../lib/common/common.js'
import xrkcfg from './xrkconfig.js'
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
    const pokeConfig = xrkcfg.poke || {}
    const modules = pokeConfig.modules || {}
    
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
        enabled: modules.pokeback ?? true,
        execute: this.pokebackSystem.bind(this)
      },
      image: {
        enabled: modules.image ?? true,
        execute: this.sendImage.bind(this)
      },
      voice: {
        enabled: modules.voice ?? true,
        execute: this.sendVoice.bind(this)
      },
      master: {
        enabled: modules.master ?? true,
        execute: this.masterProtection.bind(this)
      }
    }

    this.startScheduledTasks()
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
      
      // 判断是否戳主人（优化的主人保护逻辑）
      if (identities.targetIsMaster && this.modules.master.enabled) {
        // 如果操作者也是主人，或者机器人自己是主人，不触发保护
        if (identities.operatorIsMaster || identities.botIsMaster) {
          return false
        }
        // 主人戳主人，不触发保护
        if (identities.operatorIsMaster && identities.targetIsMaster) {
          return false
        }
        return await this.handleMasterPoke(e, identities)
      }

      // 只处理戳机器人的情况
      if (e.target_id !== e.self_id) return false

      // 冷却检查
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

  /** 获取身份信息 */
  async getIdentities(e) {
    const operatorMember = e.group.pickMember(e.operator_id)
    const botMember = e.group.pickMember(e.self_id)
    const targetMember = e.target_id ? e.group.pickMember(e.target_id) : null
    
    const masterQQ = cfg.masterQQ || []
    
    return {
      operatorIsMaster: e.isMaster || masterQQ.includes(String(e.operator_id)),
      targetIsMaster: masterQQ.includes(String(e.target_id)),
      botIsMaster: masterQQ.includes(String(e.self_id)),
      operatorIsOwner: operatorMember?.is_owner || false,
      operatorIsAdmin: operatorMember?.is_admin || false,
      targetIsOwner: targetMember?.is_owner || false,
      targetIsAdmin: targetMember?.is_admin || false,
      botIsOwner: botMember?.is_owner || false,
      botIsAdmin: botMember?.is_admin || false,
      operatorRole: operatorMember?.is_owner ? 'owner' : 
                   operatorMember?.is_admin ? 'admin' : 'member',
      botRole: botMember?.is_owner ? 'owner' : 
              botMember?.is_admin ? 'admin' : 'member'
    }
  }

  /** 冷却检查 */
  async checkCooldown(userId, type) {
    const cooldowns = xrkcfg.poke?.cooldowns || {}
    const cooldownTime = cooldowns[type] || 3000
    
    const key = `${REDIS_PREFIX.COOLDOWN}${type}:${userId}`
    const lastTime = await storage.get(key)
    const now = Date.now()
    
    if (lastTime && now - parseInt(lastTime) < cooldownTime) {
      return false
    }
    
    await storage.setEx(key, 86400, now.toString())
    return true
  }

  /** 更新基础信息 */
  async updateBasicInfo(e, userState) {
    const now = Date.now()
    
    // 连续戳判定（30秒内算连续）
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
    const moduleOrder = ['mood', 'intimacy', 'achievement', 'special', 'basic', 'punishment', 'pokeback', 'image', 'voice']
    
    for (const name of moduleOrder) {
      const module = this.modules[name]
      if (module && module.enabled) {
        try {
          results[name] = await module.execute(e, userState, identities)
          
          // 某些模块之间添加延迟，避免消息过快
          if (['basic', 'special', 'achievement'].includes(name) && results[name]) {
            await common.sleep(500)
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
    const moodChange = this.calculateMoodChange(userState, identities)
    userState.moodValue = Math.max(0, Math.min(100, userState.moodValue + moodChange))
    
    // 心情等级判定
    const oldMood = userState.mood
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

    // 心情变化提示
    if (oldMood !== userState.mood && Math.random() < 0.4) {
      const moodReplies = responses.mood[userState.mood]
      if (moodReplies && moodReplies.length > 0) {
        const reply = moodReplies[Math.floor(Math.random() * moodReplies.length)]
        await e.reply([
          segment.at(e.operator_id),
          `\n💭 ${this.formatReply(reply, e, userState)}`
        ])
      }
    }

    return userState.mood
  }

  /** 亲密度系统模块 */
  async intimacySystem(e, userState, identities) {
    let intimacyChange = 1
    
    // 根据各种因素调整亲密度变化
    if (identities.operatorIsMaster) intimacyChange += 3
    if (userState.mood === 'happy' || userState.mood === 'excited') intimacyChange += 1
    if (userState.mood === 'angry') intimacyChange -= 1
    if (userState.consecutivePokes > 10) intimacyChange -= 2
    if (userState.consecutivePokes > 20) intimacyChange -= 5
    
    // 每日首次戳额外奖励
    const dailyCount = await this.getDailyCount(e.operator_id)
    if (dailyCount === 1) {
      intimacyChange += 3
    }
    
    userState.intimacy = Math.max(0, userState.intimacy + intimacyChange)
    
    // 关系等级变化检测
    const oldRelationship = userState.relationship
    userState.relationship = this.getRelationshipLevel(userState.intimacy)
    
    if (oldRelationship !== userState.relationship) {
      const upgradeReplies = responses.relationship?.upgrade?.[userState.relationship]
      if (upgradeReplies && upgradeReplies.length > 0) {
        const reply = upgradeReplies[Math.floor(Math.random() * upgradeReplies.length)]
        await e.reply([
          segment.at(e.operator_id),
          `\n🎉 关系升级！\n${this.formatReply(reply, e, userState)}\n`,
          `当前亲密度：${userState.intimacy}`
        ])
      }
    }
    
    return userState.intimacy
  }

  /** 成就系统模块 */
  async achievementSystem(e, userState, identities) {
    const achievements = []
    const dailyCount = await this.getDailyCount(e.operator_id)
    
    const achievementChecks = [
      { id: 'first_poke', condition: userState.totalPokes === 1, name: '初次见面' },
      { id: 'poke_10', condition: userState.totalPokes === 10, name: '戳戳新手' },
      { id: 'poke_100', condition: userState.totalPokes === 100, name: '戳戳达人' },
      { id: 'poke_1000', condition: userState.totalPokes === 1000, name: '戳戳大师' },
      { id: 'poke_5000', condition: userState.totalPokes === 5000, name: '戳戳之神' },
      { id: 'consecutive_10', condition: userState.consecutivePokes === 10, name: '连击达人' },
      { id: 'consecutive_30', condition: userState.consecutivePokes === 30, name: '连击大师' },
      { id: 'intimate_100', condition: userState.intimacy >= 100, name: '亲密好友' },
      { id: 'intimate_500', condition: userState.intimacy >= 500, name: '至交挚友' },
      { id: 'intimate_1000', condition: userState.intimacy >= 1000, name: '灵魂伴侣' },
      { id: 'mood_master', condition: userState.moodValue >= 90, name: '心情调节大师' },
      { id: 'daily_100', condition: dailyCount >= 100, name: '今日戳王' },
      { id: 'night_owl', condition: new Date().getHours() >= 2 && new Date().getHours() < 5, name: '深夜戳戳党' },
      { id: 'early_bird', condition: new Date().getHours() >= 5 && new Date().getHours() < 7, name: '早起戳戳鸟' }
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
        
        // 成就奖励
        if (check.id.includes('poke_')) {
          userState.intimacy += parseInt(check.id.split('_')[1]) / 10
        }
      }
    }
    
    return achievements
  }

  /** 特殊效果模块 */
  async specialEffects(e, userState, identities) {
    if (!await this.checkCooldown(e.operator_id, 'special_effect')) {
      return []
    }
    
    const effects = []
    const chances = xrkcfg.poke?.chances || {}
    const specialChance = chances.special_trigger || 0.15
    
    // 时间特效
    const hour = new Date().getHours()
    if (Math.random() < specialChance) {
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
            `\n⏰ ${this.formatReply(reply, e, userState)}`
          ])
          effects.push(timeEffect)
        }
      }
    }
    
    // 特殊效果（暴击、连击等）
    if (Math.random() < specialChance * 1.5 && userState.intimacy > 50) {
      const specialEffects = ['lucky', 'critical', 'combo', 'special', 'buff']
      
      // 高亲密度解锁更多效果
      if (userState.intimacy > 200) {
        specialEffects.push('buff')
      }
      if (userState.consecutivePokes > 5) {
        specialEffects.push('combo')
      }
      
      const effect = specialEffects[Math.floor(Math.random() * specialEffects.length)]
      const effectReplies = responses.special_effects?.[effect]
      
      if (effectReplies && effectReplies.length > 0) {
        const reply = effectReplies[Math.floor(Math.random() * effectReplies.length)]
        await e.reply([
          segment.at(e.operator_id),
          `\n✨ ${this.formatReply(reply, e, userState)}`
        ])
        effects.push(effect)
        
        // 特效加成
        if (effect === 'lucky') {
          userState.intimacy += 10
          userState.moodValue += 10
        } else if (effect === 'critical') {
          userState.intimacy += 5
        } else if (effect === 'buff') {
          userState.moodValue = Math.min(100, userState.moodValue + 20)
        }
      }
    }
    
    return effects
  }

  /** 惩罚系统模块 */
  async punishmentSystem(e, userState, identities) {
    if (userState.consecutivePokes <= 5) return null
    
    const punishments = []
    const punishChance = xrkcfg.poke?.chances?.punishment || 0.3
    
    // 禁言惩罚
    if (this.canMute(identities) && Math.random() < punishChance) {
      const muteTime = Math.min(60 * Math.floor(userState.consecutivePokes / 5), 600)
      
      try {
        await e.group.muteMember(e.operator_id, muteTime)
        const muteReplies = responses.punishments?.mute?.success || ["禁言成功！"]
        const reply = muteReplies[Math.floor(Math.random() * muteReplies.length)]
        
        await e.reply([
          segment.at(e.operator_id),
          `\n⛔ ${this.formatReply(reply, e, userState)}\n`,
          `禁言时长：${muteTime}秒`
        ])
        
        punishments.push('mute')
      } catch (err) {
        if (Math.random() < 0.5) {
          const failReplies = responses.punishments?.mute?.fail || ["禁言失败..."]
          const reply = failReplies[Math.floor(Math.random() * failReplies.length)]
          
          await e.reply([
            segment.at(e.operator_id),
            `\n${this.formatReply(reply, e, userState)}`
          ])
        }
      }
    }
    
    // 亲密度惩罚
    if (userState.consecutivePokes > 10 && Math.random() < 0.5) {
      const reduction = Math.min(userState.consecutivePokes * 2, 30)
      userState.intimacy = Math.max(0, userState.intimacy - reduction)
      
      const reductionReplies = responses.punishments?.intimacy_reduction || ["亲密度下降了..."]
      const reply = reductionReplies[Math.floor(Math.random() * reductionReplies.length)]
      
      await e.reply([
        segment.at(e.operator_id),
        `\n💔 ${this.formatReply(reply.replace('{reduction}', reduction), e, userState)}`
      ])
      
      punishments.push('intimacy')
    }
    
    // 心情值惩罚
    userState.moodValue = Math.max(0, userState.moodValue - userState.consecutivePokes * 2)
    
    return punishments
  }

  /** 反戳系统模块 */
  async pokebackSystem(e, userState, identities) {
    if (!xrkcfg.poke?.pokeback_enabled) return false
    
    let pokebackChance = 0.3
    
    // 根据状态调整反戳概率
    if (userState.mood === 'angry') pokebackChance += 0.3
    if (userState.mood === 'excited') pokebackChance += 0.1
    if (userState.consecutivePokes > 5) pokebackChance += 0.2
    if (userState.consecutivePokes > 10) pokebackChance += 0.3
    if (identities.operatorIsMaster) pokebackChance -= 0.2
    if (userState.intimacy > 500) pokebackChance += 0.1
    
    if (Math.random() < pokebackChance) {
      const pokebackReplies = responses.pokeback?.[userState.mood] || responses.pokeback?.normal || ["戳回去！"]
      const reply = pokebackReplies[Math.floor(Math.random() * pokebackReplies.length)]
      
      await e.reply([
        segment.at(e.operator_id),
        `\n👉 ${this.formatReply(reply, e, userState)}`
      ])
      
      // 计算反戳次数
      let pokeCount = 1
      if (userState.consecutivePokes > 5) pokeCount = Math.min(Math.floor(userState.consecutivePokes / 3), 5)
      if (userState.mood === 'angry') pokeCount = Math.min(pokeCount * 2, 10)
      
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
    
    // 根据状态调整图片概率
    if (userState.mood === 'happy' || userState.mood === 'excited') imageChance += 0.2
    if (userState.intimacy > 100) imageChance += 0.1
    if (userState.intimacy > 500) imageChance += 0.1
    
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
        
        // 备用：从API获取图片
        if (Math.random() < 0.5) {
          try {
            const response = await fetch("https://api.xingdream.top/API/poke.php")
            const data = await response.json()
            if (data?.status == 200 && data?.link) {
              await e.reply(segment.image(data.link))
              return true
            }
          } catch (err) {
            logger.debug('[戳一戳] API图片获取失败')
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
    
    // 根据状态调整语音概率
    if (userState.mood === 'excited') voiceChance += 0.1
    if (userState.intimacy > 200) voiceChance += 0.1
    if (userState.relationship === 'intimate' || userState.relationship === 'soulmate') voiceChance += 0.1
    
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

  /** 处理戳主人（优化后的逻辑） */
  async handleMasterPoke(e, identities) {
    const record = await this.getMasterPokeRecord(e.group_id, e.operator_id)
    record.count++
    record.lastPoke = Date.now()
    await this.saveMasterPokeRecord(e.group_id, e.operator_id, record)
    
    // 选择回复池
    let replyPool = responses.master_protection?.normal || ["不许戳主人！"]
    
    if (identities.operatorIsOwner) {
      replyPool = responses.master_protection?.owner_warning || replyPool
    } else if (identities.operatorIsAdmin) {
      replyPool = responses.master_protection?.admin_warning || replyPool
    } else if (record.count > 5) {
      replyPool = responses.master_protection?.repeat_offender || replyPool
    }
    
    const reply = replyPool[Math.floor(Math.random() * replyPool.length)]
      .replace('{count}', record.count)
    
    await e.reply([
      segment.at(e.operator_id),
      `\n⚠️ ${reply}`
    ])
    
    // 发送保护图片
    if (xrkcfg.poke?.master_image && Math.random() < 0.7) {
      try {
        const response = await fetch("https://api.xingdream.top/API/poke.php")
        const data = await response.json()
        if (data?.status == 200 && data?.link) {
          await e.reply(segment.image(data.link))
        }
      } catch (err) {
        logger.debug('[戳主人] 图片获取失败')
      }
    }
    
    // 执行惩罚
    if (xrkcfg.poke?.master_punishment) {
      await this.punishMasterPoker(e, identities, record)
    }
    
    return true
  }

  /** 惩罚戳主人的人 */
  async punishMasterPoker(e, identities, record) {
    // 根据次数决定惩罚等级
    let punishLevel = 1
    if (record.count > 3) punishLevel = 2
    if (record.count > 10) punishLevel = 3
    if (record.count > 20) punishLevel = 4
    
    // 禁言惩罚
    if (this.canMute(identities) && Math.random() < Math.min(0.3 * punishLevel, 0.9)) {
      const baseTime = 60
      const muteTime = Math.min(baseTime * punishLevel * Math.min(record.count, 10), 3600)
      
      try {
        await e.group.muteMember(e.operator_id, muteTime)
        const muteReplies = responses.master_protection?.punishments?.mute || ["执行禁言！"]
        const reply = muteReplies[Math.floor(Math.random() * muteReplies.length)]
        await e.reply(`${reply} (${muteTime}秒)`)
      } catch (err) {
        if (Math.random() < 0.3) {
          const failReplies = responses.master_protection?.punishments?.mute_fail || ["禁言失败..."]
          const reply = failReplies[Math.floor(Math.random() * failReplies.length)]
          await e.reply(reply)
        }
      }
    }
    
    // 反戳惩罚
    if (xrkcfg.poke?.pokeback_enabled && Math.random() < Math.min(0.5 + punishLevel * 0.1, 0.9)) {
      const pokeReplies = responses.master_protection?.punishments?.poke || ["反击！"]
      const reply = pokeReplies[Math.floor(Math.random() * pokeReplies.length)]
      await e.reply(reply)
      
      const pokeCount = Math.min(3 * punishLevel, 15)
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
    
    // 基础关系回复
    const relationshipReplies = responses.relationship?.[userState.relationship] || responses.relationship?.stranger || []
    pool = [...relationshipReplies]
    
    // 添加心情回复
    if (responses.mood?.[userState.mood] && Math.random() < 0.3) {
      pool = [...pool, ...responses.mood[userState.mood]]
    }
    
    // 主人特殊回复
    if (identities.operatorIsMaster && responses.special_identity?.master) {
      pool = [...pool, ...responses.special_identity.master]
    }
    
    // 节日特殊回复
    const month = new Date().getMonth() + 1
    const day = new Date().getDate()
    
    if (month === 1 && day <= 7) {
      if (responses.festival_effects?.new_year) {
        pool = [...pool, ...responses.festival_effects.new_year]
      }
    } else if (month === 2 && day === 14) {
      if (responses.festival_effects?.valentine) {
        pool = [...pool, ...responses.festival_effects.valentine]
      }
    } else if (month === 12 && day >= 24 && day <= 26) {
      if (responses.festival_effects?.christmas) {
        pool = [...pool, ...responses.festival_effects.christmas]
      }
    }
    
    return pool
  }

  /** 计算回复概率 */
  calculateReplyChance(userState, identities) {
    let chance = 0.6
    
    // 亲密度影响
    chance += Math.min(0.3, userState.intimacy / 1000)
    
    // 心情影响
    if (userState.mood === 'happy' || userState.mood === 'excited') chance += 0.1
    if (userState.mood === 'angry') chance -= 0.2
    if (userState.mood === 'sad') chance -= 0.1
    
    // 连续戳影响
    if (userState.consecutivePokes > 5) chance -= 0.3
    if (userState.consecutivePokes > 10) chance -= 0.4
    
    // 身份影响
    if (identities.operatorIsMaster) chance += 0.2
    
    return Math.max(0.1, Math.min(1, chance))
  }

  /** 计算心情变化 */
  calculateMoodChange(userState, identities) {
    let change = 0
    const moodChangeChance = xrkcfg.poke?.chances?.mood_change || 0.3
    
    if (Math.random() > moodChangeChance) return 0
    
    // 基础变化
    if (userState.consecutivePokes <= 3) {
      change = Math.random() * 10 - 2 // -2 到 8
    } else if (userState.consecutivePokes <= 10) {
      change = -Math.random() * 5 - 2 // -7 到 -2
    } else {
      change = -Math.random() * 15 - 5 // -20 到 -5
    }
    
    // 主人加成
    if (identities.operatorIsMaster) change += 5
    
    // 时间影响
    const hour = new Date().getHours()
    if (hour >= 22 || hour < 6) change -= 3
    if (hour >= 9 && hour < 11) change += 2
    if (hour >= 14 && hour < 17) change += 1
    
    // 亲密度影响
    if (userState.intimacy > 500) change += 2
    if (userState.intimacy > 1000) change += 3
    
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
      .replace(/{mood}/g, this.getMoodText(userState.mood))
      .replace(/{consecutive}/g, userState.consecutivePokes)
      .replace(/{total}/g, userState.totalPokes)
      .replace(/{relationship}/g, this.getRelationshipText(userState.relationship))
  }

  /** 获取心情文字 */
  getMoodText(mood) {
    const moodMap = {
      angry: '生气',
      sad: '难过',
      normal: '普通',
      happy: '开心',
      excited: '兴奋'
    }
    return moodMap[mood] || mood
  }

  /** 获取关系文字 */
  getRelationshipText(relationship) {
    const relationshipMap = {
      stranger: '陌生人',
      acquaintance: '认识的人',
      friend: '朋友',
      close_friend: '亲密朋友',
      best_friend: '最好的朋友',
      intimate: '亲密无间',
      soulmate: '灵魂伴侣'
    }
    return relationshipMap[relationship] || relationship
  }

  /** 判断是否可以禁言 */
  canMute(identities) {
    // 机器人是群主
    if (identities.botIsOwner) return true
    
    // 机器人是管理员
    if (identities.botIsAdmin) {
      // 不能禁言群主和管理员
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
        const pokeEmojis = ['👉', '👈', '👆', '👇', '☝️', '👋', '✋', '🤏', '👊']
        const emoji = pokeEmojis[Math.floor(Math.random() * pokeEmojis.length)]
        await e.reply([
          segment.at(userId),
          ` ${emoji} 戳你一下！`
        ])
      }
    } catch (err) {
      logger.debug('[戳一戳] 戳成员失败')
    }
  }

  /** 定时任务 */
  startScheduledTasks() {
    // 每小时检查一次
    setInterval(() => {
      const hour = new Date().getHours()
      if (hour === 0) {
        this.resetDailyData()
      }
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
      
      let cleanedCount = 0
      for (const pattern of patterns) {
        const keys = await storage.keys(pattern)
        for (const key of keys) {
          const ttl = await storage.ttl(key)
          if (ttl === -1) {
            // 没有设置过期时间的数据，检查是否太旧
            const data = await storage.get(key)
            if (data) {
              try {
                const parsed = JSON.parse(data)
                if (parsed.lastInteraction && Date.now() - parsed.lastInteraction > 30 * 24 * 3600000) {
                  await storage.del(key)
                  cleanedCount++
                }
              } catch {}
            }
          }
        }
      }
      
      if (cleanedCount > 0) {
        logger.info(`[戳一戳] 清理了${cleanedCount}条过期数据`)
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
        // 确保所有字段都存在
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
      // 保存7天
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
      const count = await storage.incr(key)
      
      // 设置过期时间到当天结束
      const now = new Date()
      const endOfDay = new Date(now)
      endOfDay.setHours(23, 59, 59, 999)
      const ttl = Math.floor((endOfDay - now) / 1000)
      await storage.expire(key, ttl)
      
      return count
    } catch (err) {
      logger.error('[戳一戳] 增加每日次数失败:', err)
      return 0
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
      await storage.setEx(key, 86400, JSON.stringify(record))
    } catch (err) {
      logger.error('[戳一戳] 保存主人戳戳记录失败:', err)
    }
  }
}