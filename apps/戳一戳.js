import plugin from '../../../lib/plugins/plugin.js'
import cfg from '../../../lib/config/config.js'
import common from '../../../lib/common/common.js'
import fs from 'fs'
import path from 'path'
import yaml from 'yaml'

// 配置常量
const INTERACTION_COOLDOWN = 30000 // 互动冷却时间（毫秒）
const MOOD_CHANGE_CHANCE = 0.2     // 心情变化概率
const MOOD_DURATION = 1800000      // 心情持续时间（毫秒）
const ROOT_PATH = process.cwd()

// 本地资源路径
const IMAGE_DIR = path.join(ROOT_PATH, 'plugins/XRK/resources/emoji/戳一戳表情')
const VOICE_DIR = path.join(ROOT_PATH, 'plugins/XRK/resources/voice')
const CHUO_CONFIG_PATH = path.join(ROOT_PATH, 'data/xrkconfig/config.yaml')
const RESPONSES_PATH = path.join(ROOT_PATH, 'plugins/XRK/config/chuochuo.json')

// 加载配置和回复数据
const config = yaml.parse(fs.readFileSync(CHUO_CONFIG_PATH, 'utf8'))
const responses = JSON.parse(fs.readFileSync(RESPONSES_PATH, 'utf8'))

// 默认用户状态
const defaultUserState = {
  intimacy: 0,
  lastInteraction: 0,
  consecutivePokes: 0,
  mood: 'normal',
  moodExpiry: null,
  lastSpecialEffect: {},
  dailyRewards: new Set()
}

// 心情选项
const MOODS = ['happy', 'normal', 'sad', 'angry']

export class EnhancedPoke extends plugin {
  constructor() {
    super({
      name: '向日葵戳一戳',
      dsc: '114514的戳一戳',
      event: 'notice.group.poke',
      priority: config.poke_priority,
      rule: [{ fnc: 'handlePoke', log: false }]
    })
    
    // 初始化特殊效果
    this.initSpecialEffects()
  }

  /** 初始化特殊效果配置 */
  initSpecialEffects() {
    this.specialEffects = [
      {
        name: "连续戳戳",
        chance: 0.15,
        requirements: {
          minIntimacy: 0,
          cooldown: 120000
        },
        execute: async (e, userState) => {
          const replies = responses.special_effects.continuous_poke.replies
          const reply = replies[Math.floor(Math.random() * replies.length)]
          await e.reply(reply)

          const pokeCount = Math.min(2 + Math.floor(userState.intimacy / 150), 4)
          for (let i = 0; i < pokeCount; i++) {
            await common.sleep(1000)
            await this.pokeMember(e, e.operator_id)
          }
        }
      },
      {
        name: "亲密互动",
        chance: 0.2,
        requirements: {
          minIntimacy: 50,
          cooldown: 300000
        },
        execute: async (e, userState) => {
          const intimacyActions = responses.special_effects.intimate_actions
          const action = intimacyActions[Math.floor(Math.random() * intimacyActions.length)]

          await e.reply([
            segment.at(e.operator_id),
            `\n${action.replace('{name}', e.sender.card || e.sender.nickname)}`
          ])

          userState.intimacy += 5
        }
      },
      {
        name: "情绪变化",
        chance: 0.15,
        requirements: {
          minIntimacy: 30,
          cooldown: 180000
        },
        execute: async (e, userState) => {
          if (Math.random() > MOOD_CHANGE_CHANCE) return

          const currentMood = userState.mood
          const newMood = MOODS[Math.floor(Math.random() * MOODS.length)]

          if (newMood !== currentMood) {
            const moodChanges = responses.special_effects.mood_changes[currentMood][newMood]
            const moodChange = moodChanges[Math.floor(Math.random() * moodChanges.length)]
            await e.reply([
              segment.at(e.operator_id),
              `\n${moodChange.replace('{name}', e.sender.card || e.sender.nickname)}`
            ])
            userState.mood = newMood
            userState.moodExpiry = Date.now() + MOOD_DURATION
          }
        }
      },
      {
        name: "每日奖励",
        chance: 0.1,
        requirements: {
          minIntimacy: 100,
          cooldown: 43200000
        },
        execute: async (e, userState) => {
          const pokeCount = await this.getDailyPokeCount(e.operator_id)
          const milestones = [10, 30, 50, 100]

          for (const milestone of milestones) {
            if (pokeCount >= milestone && !userState.dailyRewards.has(milestone)) {
              const reward = Math.floor(milestone / 2)
              userState.intimacy += reward
              userState.dailyRewards.add(milestone)

              await e.reply([
                segment.at(e.operator_id),
                `\n恭喜达成每日戳戳${milestone}次！奖励${reward}点亲密度~`
              ])
              break
            }
          }
        }
      },
      {
        name: "特殊问候",
        chance: 0.15,
        requirements: {
          minIntimacy: 20,
          cooldown: 3600000
        },
        execute: async (e, userState) => {
          const hour = new Date().getHours()
          let greetings

          if (hour < 6) {
            greetings = responses.special_effects.greetings.night || 
                       responses.special_effects.greetings.evening
          } else if (hour < 12) {
            greetings = responses.special_effects.greetings.morning
          } else if (hour < 18) {
            greetings = responses.special_effects.greetings.afternoon
          } else {
            greetings = responses.special_effects.greetings.evening
          }

          const greeting = greetings[Math.floor(Math.random() * greetings.length)]
          await e.reply([
            segment.at(e.operator_id),
            `\n${greeting.replace('{name}', e.sender.card || e.sender.nickname)}`
          ])
        }
      },
      {
        name: "亲密度提升",
        chance: 0.1,
        requirements: {
          minIntimacy: 200,
          cooldown: 7200000
        },
        execute: async (e, userState) => {
          const oldLevel = Math.floor(userState.intimacy / 100)
          userState.intimacy += Math.floor(Math.random() * 10) + 1
          const newLevel = Math.floor(userState.intimacy / 100)

          if (newLevel > oldLevel) {
            const levelUpMsgs = responses.intimacy_responses.level_up
            const levelUpMsg = levelUpMsgs[Math.floor(Math.random() * levelUpMsgs.length)]
            await e.reply([
              segment.at(e.operator_id),
              `\n${levelUpMsg.replace('{name}', e.sender.card || e.sender.nickname)}`
            ])
          }
        }
      }
    ]
  }

  /** 戳群成员（兼容各种适配器） */
  async pokeMember(e, userId) {
    try {
      // 优先尝试使用pokeMember方法
      if (e.group?.pokeMember) {
        await e.group.pokeMember(userId)
      } else {
        // 备用方案：发送戳一戳表情或文字
        await e.reply([
          segment.at(userId),
          '\n👉 戳你一下！'
        ])
      }
    } catch (err) {
      logger.error('[戳一戳] 戳成员失败:', err)
    }
  }

  /** 主处理逻辑 */
  async handlePoke(e) {
    try {
      // 忽略自己戳自己
      if (e.operator_id === e.target_id) {
        logger.info('[检测到自己戳自己，已忽略]')
        return true
      }
      
      // 戳主人的情况交给masterPoke处理
      if (cfg.masterQQ.includes(e.target_id)) {
        return false
      }
      
      // 只处理戳机器人的情况
      if (e.target_id !== e.self_id) {
        return false
      }

      logger.info('[戳一戳生效]')
      
      // 获取或初始化用户状态
      const userState = await this.getUserState(e.operator_id) || { ...defaultUserState }
      const now = Date.now()

      // 检查冷却时间和连续戳次数
      if (now - userState.lastInteraction < INTERACTION_COOLDOWN) {
        userState.consecutivePokes++
        if (userState.consecutivePokes > 5) {
          await this.handleExcessivePokes(e, userState)
          await this.saveUserState(e.operator_id, userState)
          return true
        }
      } else {
        userState.consecutivePokes = 1
      }

      userState.lastInteraction = now
      await this.incrementDailyPokeCount(e.operator_id)

      // 并行处理各种响应
      await Promise.all([
        this.checkConsecutiveMilestones(e, userState),
        this.updateMood(userState),
        this.handleResponses(e, userState)
      ])

      await this.saveUserState(e.operator_id, userState)
      return true
    } catch (err) {
      logger.error('[戳一戳] 处理失败:', err)
      return false
    }
  }

  /** 处理回复逻辑 */
  async handleResponses(e, userState) {
    // 计算各种概率
    const intimacyBonus = Math.min(0.2, userState.intimacy / 1000)
    const moodBonus = userState.mood === 'happy' ? 0.1 : 
                      userState.mood === 'sad' ? -0.1 : 0

    const shouldSendImage = Math.random() < (0.35 + intimacyBonus + moodBonus)
    const shouldSendVoice = Math.random() < (0.2 + intimacyBonus + moodBonus)

    // 处理文本回复
    await this.handleTextResponse(e, userState)

    // 并行发送图片和语音
    const tasks = []
    if (shouldSendImage) tasks.push(this.sendImage(e))
    if (shouldSendVoice) tasks.push(this.sendVoice(e))
    
    if (tasks.length > 0) {
      await Promise.all(tasks)
    }

    // 随机增加亲密度
    if (Math.random() < 0.5) {
      userState.intimacy += Math.floor(Math.random() * 3) + 1
    }
  }

  /** 处理文本回复 */
  async handleTextResponse(e, userState) {
    const specialEffectTriggered = await this.tryTriggerSpecialEffect(e, userState)
    if (!specialEffectTriggered) {
      await this.tryNormalReply(e, userState)
    }
  }

  /** 尝试触发特殊效果 */
  async tryTriggerSpecialEffect(e, userState) {
    const validEffects = this.specialEffects.filter(effect => {
      const { minIntimacy, cooldown } = effect.requirements
      const lastTrigger = userState.lastSpecialEffect[effect.name] || 0
      return userState.intimacy >= minIntimacy && Date.now() - lastTrigger >= cooldown
    })

    if (!validEffects.length) return false
    
    const effect = validEffects[Math.floor(Math.random() * validEffects.length)]
    if (Math.random() < effect.chance) {
      userState.lastSpecialEffect[effect.name] = Date.now()
      await effect.execute(e, userState)
      return true
    }
    return false
  }

  /** 尝试普通回复 */
  async tryNormalReply(e, userState) {
    const intimacyBonus = Math.min(0.2, userState.intimacy / 1000)
    const moodBonus = userState.mood === 'happy' ? 0.1 : 
                      userState.mood === 'sad' ? -0.1 : 0
    const replyChance = 0.75 + intimacyBonus + moodBonus

    // 根据亲密度选择回复
    let replies
    if (userState.intimacy < 100) {
      replies = responses.normal_replies.low_intimacy
    } else if (userState.intimacy < 300) {
      replies = responses.normal_replies.medium_intimacy
    } else {
      replies = responses.normal_replies.high_intimacy
    }

    if (Math.random() < replyChance) {
      const reply = replies[Math.floor(Math.random() * replies.length)]
      await e.reply([segment.at(e.operator_id), `\n${reply}`])

      // 额外的心情回复
      if (userState.mood !== 'normal' && Math.random() < 0.3) {
        const moodReplies = responses.mood_status[userState.mood]
        const moodReply = moodReplies[Math.floor(Math.random() * moodReplies.length)]
        await e.reply([segment.at(e.operator_id), `\n${moodReply}`])
      }
    }
  }

  /** 发送图片 */
  async sendImage(e) {
    try {
      const files = fs.readdirSync(IMAGE_DIR).filter(file =>
        /\.(jpg|jpeg|png|gif|webp)$/i.test(file)
      )
      
      if (!files.length) {
        logger.warn('[戳一戳] 图片目录为空')
        return
      }
      
      const randomFile = files[Math.floor(Math.random() * files.length)]
      await e.reply(segment.image(`file://${path.join(IMAGE_DIR, randomFile)}`))
    } catch (err) {
      logger.error('[戳一戳] 发送图片失败:', err)
    }
  }

  /** 发送语音 */
  async sendVoice(e) {
    try {
      const files = fs.readdirSync(VOICE_DIR).filter(file =>
        /\.(mp3|wav|ogg|silk|amr)$/i.test(file)
      )
      
      if (!files.length) {
        logger.warn('[戳一戳] 语音目录为空')
        return
      }
      
      const randomFile = files[Math.floor(Math.random() * files.length)]
      await e.reply(segment.record(`file://${path.join(VOICE_DIR, randomFile)}`))
    } catch (err) {
      logger.error('[戳一戳] 发送语音失败:', err)
    }
  }

  /** 检查连续戳戳里程碑 */
  async checkConsecutiveMilestones(e, userState) {
    const milestones = Object.keys(responses.special_interactions.consecutive || {})
      .map(Number)
      .sort((a, b) => a - b)
      
    for (const milestone of milestones) {
      if (userState.consecutivePokes === milestone) {
        const replies = responses.special_interactions.consecutive[milestone]
        const reply = replies[Math.floor(Math.random() * replies.length)]
        await e.reply([segment.at(e.operator_id), `\n${reply}`])
        break
      }
    }
  }

  /** 更新心情 */
  async updateMood(userState) {
    if (userState.moodExpiry && Date.now() > userState.moodExpiry) {
      userState.mood = 'normal'
      userState.moodExpiry = null
    }
  }

  /** 处理过度戳戳 */
  async handleExcessivePokes(e, userState) {
    const punishments = [
      {
        name: '禁言惩罚',
        chance: 0.3,
        execute: async () => {
          const canMuteResult = await this.canMute(e, e.operator_id)
          
          if (canMuteResult.canMute) {
            const muteTime = Math.min(3 + Math.floor(userState.consecutivePokes / 3), 15)
            await e.group.muteMember(e.operator_id, muteTime * 60)
            const muteReplies = responses.punishments.mute
            const reply = muteReplies[Math.floor(Math.random() * muteReplies.length)]
            await e.reply(reply)
          } else {
            const muteFailReplies = responses.punishments.mute_fail || [
              "想禁言你，但是我做不到...",
              "唔...没有权限禁言你呢，不过下次可不要这样了！",
              "看在我没权限的份上，饶了你这次！"
            ]
            const reply = muteFailReplies[Math.floor(Math.random() * muteFailReplies.length)]
            await e.reply([
              segment.at(e.operator_id),
              `\n${reply}`
            ])
            
            if (canMuteResult.reason) {
              logger.info(`[无法禁言] 原因: ${canMuteResult.reason}`)
            }
          }
        }
      },
      {
        name: '亲密度惩罚',
        chance: 0.3,
        execute: async () => {
          const reduction = Math.min(10, userState.consecutivePokes)
          userState.intimacy = Math.max(0, userState.intimacy - reduction)
          const reductionReplies = responses.punishments.intimacy_reduction
          const reply = reductionReplies[Math.floor(Math.random() * reductionReplies.length)]
          await e.reply([
            segment.at(e.operator_id),
            `\n${reply.replace('{reduction}', reduction)}`
          ])
        }
      },
      {
        name: '连续戳回击',
        chance: 0.4,
        execute: async () => {
          const pokeReplies = responses.punishments.poke
          const reply = pokeReplies[Math.floor(Math.random() * pokeReplies.length)]
          await e.reply(reply)
          
          const pokeCount = Math.min(userState.consecutivePokes, 5)
          for (let i = 0; i < pokeCount; i++) {
            await common.sleep(1000)
            await this.pokeMember(e, e.operator_id)
          }
        }
      }
    ]

    // 根据概率选择惩罚
    const totalChance = punishments.reduce((sum, p) => sum + p.chance, 0)
    let random = Math.random() * totalChance

    for (const punishment of punishments) {
      random -= punishment.chance
      if (random <= 0) {
        await punishment.execute()
        break
      }
    }
  }

  /** 检查是否可以禁言 */
  async canMute(e, targetId) {
    try {
      if (!e.group || !e.group.pickMember) {
        return { canMute: false, reason: '不在群聊中' }
      }
      
      if (cfg.masterQQ.includes(targetId)) {
        return { canMute: false, reason: '目标是机器人主人' }
      }
      
      const botMember = e.group.pickMember(e.self_id)
      const targetMember = e.group.pickMember(targetId)
      
      if (!botMember?.info || !targetMember?.info) {
        return { canMute: false, reason: '无法获取成员信息' }
      }

      const botRole = botMember.info.role
      const targetRole = targetMember.info.role

      if (botRole === 'owner') {
        return { canMute: true }
      }
      
      if (botRole === 'admin' && targetRole === 'member') {
        return { canMute: true }
      }
      
      return { canMute: false, reason: '机器人权限不足' }
    } catch (err) {
      logger.error('[戳一戳] 检查禁言权限失败:', err)
      return { canMute: false, reason: err.message }
    }
  }

  /** Redis 操作方法 */
  async getUserState(userId) {
    try {
      const key = `xrk:userState:${userId}`
      const data = await redis.get(key)
      
      if (data) {
        const state = JSON.parse(data)
        // 恢复Set对象
        state.dailyRewards = new Set(state.dailyRewards || [])
        return state
      }
      
      return null
    } catch (err) {
      logger.error('[戳一戳] 获取用户状态失败:', err)
      return null
    }
  }

  async saveUserState(userId, userState) {
    try {
      const key = `xrk:userState:${userId}`
      // 将Set转换为数组以便存储
      const stateToSave = { 
        ...userState, 
        dailyRewards: Array.from(userState.dailyRewards || [])
      }
      await redis.set(key, JSON.stringify(stateToSave))
      // 设置7天过期
      await redis.expire(key, 604800)
    } catch (err) {
      logger.error('[戳一戳] 保存用户状态失败:', err)
    }
  }

  async getDailyPokeCount(userId) {
    try {
      const key = `xrk:dailyPokeCount:${userId}`
      const count = await redis.get(key)
      return count ? parseInt(count) : 0
    } catch (err) {
      logger.error('[戳一戳] 获取每日戳戳次数失败:', err)
      return 0
    }
  }

  async incrementDailyPokeCount(userId) {
    try {
      const key = `xrk:dailyPokeCount:${userId}`
      await redis.incr(key)
      // 设置当天结束时过期
      const now = new Date()
      const endOfDay = new Date(now)
      endOfDay.setHours(23, 59, 59, 999)
      const ttl = Math.floor((endOfDay - now) / 1000)
      await redis.expire(key, ttl)
    } catch (err) {
      logger.error('[戳一戳] 增加每日戳戳次数失败:', err)
    }
  }
}