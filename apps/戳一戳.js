import plugin from '../../../lib/plugins/plugin.js'
import cfg from '../../../lib/config/config.js'
import common from '../../../lib/common/common.js'
import fs from 'fs'
import path from 'path'
import yaml from 'yaml'
import fetch from 'node-fetch'

const ROOT_PATH = process.cwd()
const CONFIG_PATH = path.join(ROOT_PATH, 'data/xrkconfig/config.yaml')
const RESPONSES_PATH = path.join(ROOT_PATH, 'plugins/XRK/config/poke_responses.json')
const IMAGE_DIR = path.join(ROOT_PATH, 'plugins/XRK/resources/emoji/戳一戳表情')
const VOICE_DIR = path.join(ROOT_PATH, 'plugins/XRK/resources/voice')

// 加载配置
const config = yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
const responses = JSON.parse(fs.readFileSync(RESPONSES_PATH, 'utf8'))

// Redis键前缀
const REDIS_PREFIX = {
  USER_STATE: 'xrk:poke:user:',
  DAILY_COUNT: 'xrk:poke:daily:',
  MASTER_RECORD: 'xrk:poke:master:'
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
      priority: config.poke?.priority || -5000,
      rule: [{ fnc: 'handlePoke', log: false }]
    })
    
    this.initModules()
  }

  /** 初始化模块系统 */
  initModules() {
    this.modules = {
      // 基础模块
      basic: {
        enabled: config.poke?.modules?.basic ?? true,
        execute: this.basicResponse.bind(this)
      },
      // 心情系统
      mood: {
        enabled: config.poke?.modules?.mood ?? true,
        execute: this.moodSystem.bind(this)
      },
      // 亲密度系统
      intimacy: {
        enabled: config.poke?.modules?.intimacy ?? true,
        execute: this.intimacySystem.bind(this)
      },
      // 成就系统
      achievement: {
        enabled: config.poke?.modules?.achievement ?? true,
        execute: this.achievementSystem.bind(this)
      },
      // 特殊效果
      special: {
        enabled: config.poke?.modules?.special ?? true,
        execute: this.specialEffects.bind(this)
      },
      // 惩罚系统
      punishment: {
        enabled: config.poke?.modules?.punishment ?? true,
        execute: this.punishmentSystem.bind(this)
      },
      // 反戳系统
      pokeback: {
        enabled: config.poke?.modules?.pokeback ?? true,
        execute: this.pokebackSystem.bind(this)
      },
      // 图片发送
      image: {
        enabled: config.poke?.modules?.image ?? true,
        execute: this.sendImage.bind(this)
      },
      // 语音发送
      voice: {
        enabled: config.poke?.modules?.voice ?? true,
        execute: this.sendVoice.bind(this)
      },
      // 主人保护
      master: {
        enabled: config.poke?.modules?.master ?? true,
        execute: this.masterProtection.bind(this)
      }
    }

    // 定时任务
    this.startScheduledTasks()
  }

  /** 主处理函数 */
  async handlePoke(e) {
    try {
      // 全局开关
      if (!config.poke?.enabled) return false

      // 忽略自己戳自己
      if (e.operator_id === e.target_id) return true

      // 获取身份信息
      const identities = await this.getIdentities(e)
      
      // 处理戳主人的情况
      if (identities.targetIsMaster && this.modules.master.enabled) {
        return await this.handleMasterPoke(e, identities)
      }

      // 只处理戳机器人的情况
      if (e.target_id !== e.self_id) return false

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
    
    return {
      operatorIsMaster: e.isMaster || cfg.masterQQ?.includes(e.operator_id),
      targetIsMaster: cfg.masterQQ?.includes(e.target_id),
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
    
    // 检查连续戳
    if (now - userState.lastInteraction < 30000) {
      userState.consecutivePokes++
    } else {
      userState.consecutivePokes = 1
    }

    userState.lastInteraction = now
    userState.totalPokes++
    
    // 更新每日统计
    await this.incrementDailyCount(e.operator_id)
  }

  /** 执行模块 */
  async executeModules(e, userState, identities) {
    const results = {}
    
    for (const [name, module] of Object.entries(this.modules)) {
      if (module.enabled) {
        try {
          results[name] = await module.execute(e, userState, identities)
        } catch (err) {
          logger.error(`[戳一戳] 模块${name}执行失败:`, err)
        }
      }
    }
    
    return results
  }

  /** 基础回复模块 */
  async basicResponse(e, userState, identities) {
    // 根据关系等级选择回复池
    const replyPool = this.getReplyPool(userState, identities)
    
    // 计算回复概率
    const replyChance = this.calculateReplyChance(userState, identities)
    
    if (Math.random() < replyChance) {
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
    // 心情值变化
    const moodChange = this.calculateMoodChange(userState, identities)
    userState.moodValue = Math.max(0, Math.min(100, userState.moodValue + moodChange))
    
    // 更新心情状态
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

    // 心情变化通知
    if (Math.abs(moodChange) > 10 && Math.random() < 0.3) {
      const moodReplies = responses.mood[userState.mood]
      const reply = moodReplies[Math.floor(Math.random() * moodReplies.length)]
      await e.reply([
        segment.at(e.operator_id),
        `\n${this.formatReply(reply, e, userState)}`
      ])
    }

    return userState.mood
  }

  /** 亲密度系统模块 */
  async intimacySystem(e, userState, identities) {
    // 计算亲密度变化
    let intimacyChange = 1
    
    // 特殊身份加成
    if (identities.operatorIsMaster) intimacyChange += 3
    if (userState.mood === 'happy') intimacyChange += 1
    if (userState.mood === 'angry') intimacyChange -= 1
    if (userState.consecutivePokes > 10) intimacyChange -= 2
    
    userState.intimacy = Math.max(0, userState.intimacy + intimacyChange)
    
    // 更新关系等级
    const oldRelationship = userState.relationship
    userState.relationship = this.getRelationshipLevel(userState.intimacy)
    
    // 关系升级通知
    if (oldRelationship !== userState.relationship) {
      const upgradeReplies = responses.relationship.upgrade[userState.relationship]
      if (upgradeReplies) {
        const reply = upgradeReplies[Math.floor(Math.random() * upgradeReplies.length)]
        await e.reply([
          segment.at(e.operator_id),
          `\n🎉 关系升级！\n${this.formatReply(reply, e, userState)}`
        ])
      }
    }
    
    return userState.intimacy
  }

  /** 成就系统模块 */
  async achievementSystem(e, userState, identities) {
    const achievements = []
    
    // 检查各种成就
    const achievementChecks = [
      { id: 'first_poke', condition: userState.totalPokes === 1, name: '初次见面' },
      { id: 'poke_10', condition: userState.totalPokes === 10, name: '戳戳新手' },
      { id: 'poke_100', condition: userState.totalPokes === 100, name: '戳戳达人' },
      { id: 'poke_1000', condition: userState.totalPokes === 1000, name: '戳戳大师' },
      { id: 'consecutive_10', condition: userState.consecutivePokes === 10, name: '连击达人' },
      { id: 'intimate_100', condition: userState.intimacy >= 100, name: '亲密好友' },
      { id: 'intimate_500', condition: userState.intimacy >= 500, name: '至交挚友' },
      { id: 'mood_master', condition: userState.moodValue >= 90, name: '心情调节大师' }
    ]
    
    for (const check of achievementChecks) {
      if (check.condition && !userState.achievements.includes(check.id)) {
        userState.achievements.push(check.id)
        achievements.push(check)
        
        // 发送成就通知
        const achievementReplies = responses.achievements[check.id] || responses.achievements.default
        const reply = achievementReplies[Math.floor(Math.random() * achievementReplies.length)]
        
        await e.reply([
          segment.at(e.operator_id),
          `\n🏆 获得成就【${check.name}】\n${this.formatReply(reply, e, userState)}`
        ])
      }
    }
    
    return achievements
  }

  /** 特殊效果模块 */
  async specialEffects(e, userState, identities) {
    const effects = []
    
    // 时间特效
    const hour = new Date().getHours()
    if (Math.random() < 0.15) {
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
      
      if (timeEffect && responses.time_effects[timeEffect]) {
        const replies = responses.time_effects[timeEffect]
        const reply = replies[Math.floor(Math.random() * replies.length)]
        
        await e.reply([
          segment.at(e.operator_id),
          `\n${this.formatReply(reply, e, userState)}`
        ])
        
        effects.push(timeEffect)
      }
    }
    
    // 随机特效
    if (Math.random() < 0.1 && userState.intimacy > 50) {
      const specialEffects = Object.keys(responses.special_effects)
      const effect = specialEffects[Math.floor(Math.random() * specialEffects.length)]
      const replies = responses.special_effects[effect]
      const reply = replies[Math.floor(Math.random() * replies.length)]
      
      await e.reply([
        segment.at(e.operator_id),
        `\n✨ ${this.formatReply(reply, e, userState)}`
      ])
      
      effects.push(effect)
    }
    
    return effects
  }

  /** 惩罚系统模块 */
  async punishmentSystem(e, userState, identities) {
    // 检查是否需要惩罚
    if (userState.consecutivePokes <= 5) return null
    
    const punishments = []
    
    // 禁言惩罚
    if (this.canMute(identities) && Math.random() < 0.3) {
      const muteTime = Math.min(60 * userState.consecutivePokes, 1800)
      
      try {
        await e.group.muteMember(e.operator_id, muteTime)
        const muteReplies = responses.punishments.mute.success
        const reply = muteReplies[Math.floor(Math.random() * muteReplies.length)]
        
        await e.reply([
          segment.at(e.operator_id),
          `\n${this.formatReply(reply, e, userState)}`
        ])
        
        punishments.push('mute')
      } catch (err) {
        const failReplies = responses.punishments.mute.fail
        const reply = failReplies[Math.floor(Math.random() * failReplies.length)]
        
        await e.reply([
          segment.at(e.operator_id),
          `\n${this.formatReply(reply, e, userState)}`
        ])
      }
    }
    
    // 亲密度惩罚
    if (Math.random() < 0.3) {
      const reduction = Math.min(userState.consecutivePokes * 2, 20)
      userState.intimacy = Math.max(0, userState.intimacy - reduction)
      
      const reductionReplies = responses.punishments.intimacy_reduction
      const reply = reductionReplies[Math.floor(Math.random() * reductionReplies.length)]
      
      await e.reply([
        segment.at(e.operator_id),
        `\n${this.formatReply(reply.replace('{reduction}', reduction), e, userState)}`
      ])
      
      punishments.push('intimacy')
    }
    
    // 心情惩罚
    userState.moodValue = Math.max(0, userState.moodValue - userState.consecutivePokes * 2)
    
    return punishments
  }

  /** 反戳系统模块 */
  async pokebackSystem(e, userState, identities) {
    if (!config.poke?.pokeback_enabled) return false
    
    // 计算反戳概率
    let pokebackChance = 0.3
    
    if (userState.mood === 'angry') pokebackChance += 0.3
    if (userState.consecutivePokes > 5) pokebackChance += 0.2
    if (identities.operatorIsMaster) pokebackChance -= 0.2
    
    if (Math.random() < pokebackChance) {
      const pokebackReplies = responses.pokeback[userState.mood] || responses.pokeback.normal
      const reply = pokebackReplies[Math.floor(Math.random() * pokebackReplies.length)]
      
      await e.reply([
        segment.at(e.operator_id),
        `\n${this.formatReply(reply, e, userState)}`
      ])
      
      // 执行反戳
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
    // 计算发送概率
    let imageChance = config.poke?.image_chance || 0.3
    
    if (userState.mood === 'happy') imageChance += 0.1
    if (userState.intimacy > 100) imageChance += 0.1
    
    if (Math.random() < imageChance) {
      try {
        const files = fs.readdirSync(IMAGE_DIR).filter(file =>
          /\.(jpg|jpeg|png|gif|webp)$/i.test(file)
        )
        
        if (files.length > 0) {
          const randomFile = files[Math.floor(Math.random() * files.length)]
          await e.reply(segment.image(`file://${path.join(IMAGE_DIR, randomFile)}`))
          return true
        }
      } catch (err) {
        logger.error('[戳一戳] 发送图片失败:', err)
      }
    }
    
    return false
  }

  /** 发送语音模块 */
  async sendVoice(e, userState, identities) {
    // 计算发送概率
    let voiceChance = config.poke?.voice_chance || 0.2
    
    if (userState.mood === 'excited') voiceChance += 0.1
    if (userState.intimacy > 200) voiceChance += 0.1
    
    if (Math.random() < voiceChance) {
      try {
        const files = fs.readdirSync(VOICE_DIR).filter(file =>
          /\.(mp3|wav|ogg|silk|amr)$/i.test(file)
        )
        
        if (files.length > 0) {
          const randomFile = files[Math.floor(Math.random() * files.length)]
          await e.reply(segment.record(`file://${path.join(VOICE_DIR, randomFile)}`))
          return true
        }
      } catch (err) {
        logger.error('[戳一戳] 发送语音失败:', err)
      }
    }
    
    return false
  }

  /** 主人保护模块 */
  async masterProtection(e, userState, identities) {
    // 这个模块在handleMasterPoke中调用
    return null
  }

  /** 处理戳主人 */
  async handleMasterPoke(e, identities) {
    // 主人自己戳自己，忽略
    if (identities.operatorIsMaster) return true
    
    // 获取戳主人记录
    const record = await this.getMasterPokeRecord(e.group_id, e.operator_id)
    record.count++
    await this.saveMasterPokeRecord(e.group_id, e.operator_id, record)
    
    // 选择回复
    let replyPool = responses.master_protection.normal
    
    if (identities.operatorIsOwner) {
      replyPool = responses.master_protection.owner_warning
    } else if (identities.operatorIsAdmin) {
      replyPool = responses.master_protection.admin_warning
    } else if (record.count > 5) {
      replyPool = responses.master_protection.repeat_offender
    }
    
    const reply = replyPool[Math.floor(Math.random() * replyPool.length)]
    
    await e.reply([
      segment.at(e.operator_id),
      `\n${reply}`
    ])
    
    // 尝试获取图片
    if (config.poke?.master_image) {
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
    
    // 执行惩罚
    if (config.poke?.master_punishment) {
      await this.punishMasterPoker(e, identities, record)
    }
    
    return true
  }

  /** 惩罚戳主人的人 */
  async punishMasterPoker(e, identities, record) {
    // 计算惩罚强度
    let punishLevel = 1
    if (record.count > 3) punishLevel = 2
    if (record.count > 10) punishLevel = 3
    
    // 尝试禁言
    if (this.canMute(identities) && Math.random() < 0.5 * punishLevel) {
      const muteTime = Math.min(300 * punishLevel * record.count, 86400)
      
      try {
        await e.group.muteMember(e.operator_id, muteTime)
        const muteReplies = responses.master_protection.punishments.mute
        const reply = muteReplies[Math.floor(Math.random() * muteReplies.length)]
        await e.reply(reply)
      } catch (err) {
        const failReplies = responses.master_protection.punishments.mute_fail
        const reply = failReplies[Math.floor(Math.random() * failReplies.length)]
        await e.reply(reply)
      }
    }
    
    // 反戳惩罚
    if (config.poke?.pokeback_enabled && Math.random() < 0.7) {
      const pokeReplies = responses.master_protection.punishments.poke
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
    
    // 根据关系等级选择基础池
    const relationshipReplies = responses.relationship[userState.relationship] || responses.relationship.stranger
    pool = [...relationshipReplies]
    
    // 根据心情添加额外回复
    if (responses.mood[userState.mood]) {
      pool = [...pool, ...responses.mood[userState.mood]]
    }
    
    // 特殊身份额外回复
    if (identities.operatorIsMaster && responses.special_identity.master) {
      pool = [...pool, ...responses.special_identity.master]
    }
    
    return pool
  }

  /** 计算回复概率 */
  calculateReplyChance(userState, identities) {
    let chance = 0.6
    
    // 亲密度加成
    chance += Math.min(0.2, userState.intimacy / 1000)
    
    // 心情影响
    if (userState.mood === 'happy') chance += 0.1
    if (userState.mood === 'angry') chance -= 0.2
    
    // 连续戳惩罚
    if (userState.consecutivePokes > 5) chance -= 0.3
    
    // 主人加成
    if (identities.operatorIsMaster) chance += 0.2
    
    return Math.max(0.1, Math.min(1, chance))
  }

  /** 计算心情变化 */
  calculateMoodChange(userState, identities) {
    let change = 0
    
    // 基础变化
    if (userState.consecutivePokes <= 3) {
      change = Math.random() * 5
    } else if (userState.consecutivePokes <= 10) {
      change = -Math.random() * 5
    } else {
      change = -Math.random() * 10
    }
    
    // 特殊身份影响
    if (identities.operatorIsMaster) change += 5
    
    // 时间影响
    const hour = new Date().getHours()
    if (hour >= 22 || hour < 6) change -= 3 // 深夜扣心情
    
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
      .replace(/{mood}/g, userState.mood)
      .replace(/{consecutive}/g, userState.consecutivePokes)
      .replace(/{total}/g, userState.totalPokes)
  }

  /** 判断是否可以禁言 */
  canMute(identities) {
    // 机器人是群主可以禁言所有人
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
    if (!config.poke?.pokeback_enabled) return
    
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
    // 每天凌晨重置每日数据
    setInterval(() => {
      const hour = new Date().getHours()
      if (hour === 0) {
        this.resetDailyData()
      }
    }, 3600000)
    
    // 每小时清理过期数据
    setInterval(() => {
      this.cleanExpiredData()
    }, 3600000)
  }

  /** 重置每日数据 */
  async resetDailyData() {
    try {
      const keys = await redis.keys(`${REDIS_PREFIX.DAILY_COUNT}*`)
      for (const key of keys) {
        await redis.del(key)
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
        `${REDIS_PREFIX.MASTER_RECORD}*`
      ]
      
      for (const pattern of patterns) {
        const keys = await redis.keys(pattern)
        for (const key of keys) {
          const ttl = await redis.ttl(key)
          if (ttl <= 0) {
            await redis.del(key)
          }
        }
      }
    } catch (err) {
      logger.error('[戳一戳] 清理过期数据失败:', err)
    }
  }

  // ========== Redis 操作 ==========

  /** 获取用户状态 */
  async getUserState(userId) {
    try {
      const key = `${REDIS_PREFIX.USER_STATE}${userId}`
      const data = await redis.get(key)
      
      if (data) {
        const state = JSON.parse(data)
        // 恢复数组和对象
        state.dailyRewards = state.dailyRewards || []
        state.achievements = state.achievements || []
        state.lastSpecialEffect = state.lastSpecialEffect || {}
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
      await redis.setEx(key, 604800, JSON.stringify(userState)) // 7天过期
    } catch (err) {
      logger.error('[戳一戳] 保存用户状态失败:', err)
    }
  }

  /** 获取每日戳戳次数 */
  async getDailyCount(userId) {
    try {
      const key = `${REDIS_PREFIX.DAILY_COUNT}${userId}`
      const count = await redis.get(key)
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
      await redis.incr(key)
      
      // 设置当天结束时过期
      const now = new Date()
      const endOfDay = new Date(now)
      endOfDay.setHours(23, 59, 59, 999)
      const ttl = Math.floor((endOfDay - now) / 1000)
      await redis.expire(key, ttl)
    } catch (err) {
      logger.error('[戳一戳] 增加每日次数失败:', err)
    }
  }

  /** 获取戳主人记录 */
  async getMasterPokeRecord(groupId, userId) {
    try {
      const key = `${REDIS_PREFIX.MASTER_RECORD}${groupId}:${userId}`
      const data = await redis.get(key)
      
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
      await redis.setEx(key, 86400, JSON.stringify(record)) // 24小时过期
    } catch (err) {
      logger.error('[戳一戳] 保存主人戳戳记录失败:', err)
    }
  }
}