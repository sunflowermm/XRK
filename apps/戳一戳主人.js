import plugin from '../../../lib/plugins/plugin.js'
import cfg from '../../../lib/config/config.js'
import common from '../../../lib/common/common.js'
import fetch from 'node-fetch'
import fs from 'fs'
import path from 'path'
import axios from 'axios'
import https from 'https'
import yaml from "yaml"

const ROOT_PATH = process.cwd()
const responses = JSON.parse(fs.readFileSync(path.join(ROOT_PATH, 'plugins/XRK/config/chuochuomaster.json'), 'utf8'))
const CHUOCONFIG = path.join(ROOT_PATH, 'data/xrkconfig/config.yaml')
const config = yaml.parse(fs.readFileSync(CHUOCONFIG, 'utf8'))

const REDIS_KEY_PREFIX = 'master_poke:'
const REDIS_EXPIRE_TIME = 24 * 60 * 60 // 24小时

const instance = axios.create({
  httpsAgent: new https.Agent({
    rejectUnauthorized: false
  })
})

export class masterPoke extends plugin {
  constructor() {
    super({
      name: '向日葵戳主人',
      dsc: '处理戳主人的情况',
      event: 'notice.group.poke',
      priority: config.corepoke_priority,
      rule: [
        {
          fnc: 'handleMasterPoke'
        }
      ]
    })
  }

  /** 启动定期清理任务 */
  init() {
    setInterval(() => {
      this.cleanExpiredRecords()
    }, 3600000) // 每小时清理一次
  }

  /** 检查是否为节日 */
  isHoliday() {
    const today = new Date()
    const month = today.getMonth() + 1
    const date = today.getDate()

    const holidays = [
      { month: 1, date: 1 },    // 元旦
      { month: 2, date: 14 },   // 情人节
      { month: 3, date: 8 },    // 妇女节
      { month: 4, date: 1 },    // 愚人节
      { month: 5, date: 1 },    // 劳动节
      { month: 5, date: 4 },    // 青年节
      { month: 6, date: 1 },    // 儿童节
      { month: 7, date: 1 },    // 建党节
      { month: 8, date: 1 },    // 建军节
      { month: 9, date: 10 },   // 教师节
      { month: 10, date: 1 },   // 国庆节
      { month: 12, date: 24 },  // 平安夜
      { month: 12, date: 25 },  // 圣诞节
    ]

    return holidays.some(holiday => holiday.month === month && holiday.date === date)
  }

  /** 生成Redis键 */
  getRedisKey(groupId, userId) {
    return `${REDIS_KEY_PREFIX}${groupId}:${userId}`
  }

  /** 获取戳戳记录 */
  async getPokeRecord(groupId, userId) {
    try {
      const key = this.getRedisKey(groupId, userId)
      const recordStr = await redis.get(key)
      
      if (!recordStr) {
        return { count: 0, lastPoke: Date.now() }
      }

      try {
        const record = JSON.parse(recordStr)
        return {
          count: parseInt(record.count) || 0,
          lastPoke: parseInt(record.lastPoke) || Date.now()
        }
      } catch (parseError) {
        logger.error('[戳主人] 解析记录失败:', parseError)
        // 清理损坏的数据
        await redis.del(key)
        return { count: 0, lastPoke: Date.now() }
      }
    } catch (err) {
      logger.error('[戳主人] 获取记录失败:', err)
      return { count: 0, lastPoke: Date.now() }
    }
  }

  /** 更新戳戳记录 */
  async updatePokeRecord(groupId, userId) {
    try {
      const key = this.getRedisKey(groupId, userId)
      const record = await this.getPokeRecord(groupId, userId)

      const newRecord = {
        count: record.count + 1,
        lastPoke: Date.now()
      }

      await redis.setEx(key, REDIS_EXPIRE_TIME, JSON.stringify(newRecord))
      return newRecord
    } catch (err) {
      logger.error('[戳主人] 更新记录失败:', err)
      return { count: 1, lastPoke: Date.now() }
    }
  }

  /** 获取用户角色信息 */
  async getUserRole(e, userId) {
    try {
      const member = e.group.pickMember(userId)
      return member?.info?.role || 'member'
    } catch (err) {
      logger.error('[戳主人] 获取用户角色失败:', err)
      return 'member'
    }
  }

  /** 获取基于角色的回复 */
  async getRoleBasedReply(e) {
    try {
      const targetRole = await this.getUserRole(e, e.operator_id)

      if (targetRole === 'owner') {
        return responses.special_replies.owner_warning[
          Math.floor(Math.random() * responses.special_replies.owner_warning.length)
        ]
      } else if (targetRole === 'admin') {
        return responses.special_replies.admin_warning[
          Math.floor(Math.random() * responses.special_replies.admin_warning.length)
        ]
      }
    } catch (err) {
      logger.error('[戳主人] 获取角色回复失败:', err)
    }
    return null
  }

  /** 获取宽恕回复 */
  async getMercyReply(groupId, userId) {
    const record = await this.getPokeRecord(groupId, userId)

    if (record.count === 1) {
      return responses.mercy_replies.first_time[
        Math.floor(Math.random() * responses.mercy_replies.first_time.length)
      ]
    }

    if (this.isHoliday()) {
      return responses.mercy_replies.holiday[
        Math.floor(Math.random() * responses.mercy_replies.holiday.length)
      ]
    }

    return null
  }

  /** 检查是否可以禁言 */
  async canMute(e, targetId) {
    try {
      if (cfg.masterQQ.includes(targetId)) {
        return { canMute: false, reason: '目标是主人' }
      }

      const botRole = await this.getUserRole(e, e.self_id)
      const targetRole = await this.getUserRole(e, targetId)

      if (botRole === 'owner') {
        return { canMute: true }
      }
      
      if (botRole === 'admin' && targetRole === 'member') {
        return { canMute: true }
      }

      return { canMute: false, reason: '权限不足' }
    } catch (err) {
      logger.error('[戳主人] 检查禁言权限失败:', err)
      return { canMute: false, reason: err.message }
    }
  }

  /** 主处理函数 */
  async handleMasterPoke(e) {
    try {
      // 配置检查
      if (!config.chuomaster) {
        return false
      }
      
      // 检查是否戳的是主人
      if (!cfg.masterQQ.includes(e.target_id)) {
        return false
      }

      logger.info('[戳主人生效]')
      
      // 主人自己戳自己或机器人戳自己，忽略
      if (cfg.masterQQ.includes(e.operator_id) || e.self_id == e.operator_id) {
        return true
      }

      // 更新记录
      const record = await this.updatePokeRecord(e.group_id, e.operator_id)
      
      // 获取回复内容
      const roleReply = await this.getRoleBasedReply(e)
      const mercyReply = await this.getMercyReply(e.group_id, e.operator_id)

      let reply
      if (roleReply) {
        reply = roleReply
      } else if (mercyReply) {
        reply = mercyReply
      } else if (record.count > 3) {
        reply = `你在过去24小时内已经戳了主人${record.count}次了！\n` +
          responses.special_replies.repeat_offender[
            Math.floor(Math.random() * responses.special_replies.repeat_offender.length)
          ]
      } else {
        reply = responses.master_replies[
          Math.floor(Math.random() * responses.master_replies.length)
        ]
      }

      // 发送回复
      try {
        const response = await fetch("https://api.xingdream.top/API/poke.php")
        const data = await response.json()

        if (data && data.status == 200) {
          await e.reply([
            segment.at(e.operator_id),
            `\n${reply}`,
            segment.image(data.link)
          ])
        } else {
          throw new Error('图片API返回异常')
        }
      } catch (err) {
        logger.error('[戳主人] 图片获取失败:', err)
        // 发送纯文字回复
        await e.reply([
          segment.at(e.operator_id),
          `\n${reply}`
        ])
      }

      // 延迟执行惩罚
      await common.sleep(1000)
      
      // 计算惩罚概率
      let punishProbability = 0.3
      if (record.count > 3) punishProbability = 0.6
      if (roleReply) punishProbability = 0.8

      if (Math.random() < punishProbability) {
        await this.punishPoker(e, record.count)
      } else {
        // 反戳（移除适配器限制）
        await this.pokeMember(e, e.operator_id)
      }

      return true
    } catch (err) {
      logger.error('[戳主人] 处理失败:', err)
      return false
    }
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
      logger.error('[戳主人] 戳成员失败:', err)
    }
  }

  /** 惩罚戳主人的人 */
  async punishPoker(e, pokeCount) {
    try {
      const canMuteResult = await this.canMute(e, e.operator_id)

      const punishments = [
        // 禁言惩罚
        async () => {
          if (canMuteResult.canMute) {
            const reply = responses.punishments.mute[
              Math.floor(Math.random() * responses.punishments.mute.length)
            ]
            await e.reply(reply)
            
            // 计算禁言时间（最少5分钟，最多30天）
            const muteTime = Math.min(300 * Math.pow(1.5, pokeCount - 1), 2592000)
            await e.group.muteMember(e.operator_id, Math.floor(muteTime))
          } else {
            const reply = responses.cant_mute_replies[
              Math.floor(Math.random() * responses.cant_mute_replies.length)
            ]
            await e.reply(reply)
            
            if (canMuteResult.reason) {
              logger.info(`[戳主人] 无法禁言: ${canMuteResult.reason}`)
            }
          }
        },
        // 连续戳回击
        async () => {
          const reply = responses.punishments.poke[
            Math.floor(Math.random() * responses.punishments.poke.length)
          ]
          await e.reply(reply)
          
          // 计算戳回次数
          const pokeBackCount = Math.min(5 + Math.floor(pokeCount * 1.5), 20)
          for (let i = 0; i < pokeBackCount; i++) {
            await common.sleep(800)
            await this.pokeMember(e, e.operator_id)
          }
        }
      ]

      // 多次戳主人的惩罚更严厉
      if (pokeCount > 3 && canMuteResult.canMute) {
        // 优先禁言
        punishments.unshift(punishments[0])
      }

      // 随机选择惩罚
      const punishment = punishments[Math.floor(Math.random() * punishments.length)]
      await punishment()
    } catch (err) {
      logger.error('[戳主人] 惩罚执行失败:', err)
    }
  }

  /** 清理过期记录 */
  async cleanExpiredRecords() {
    try {
      const keys = await redis.keys(`${REDIS_KEY_PREFIX}*`)
      let cleanedCount = 0
      
      for (const key of keys) {
        const ttl = await redis.ttl(key)
        if (ttl <= 0) {
          await redis.del(key)
          cleanedCount++
        }
      }
      
      if (cleanedCount > 0) {
        logger.info(`[戳主人] 清理了${cleanedCount}条过期记录`)
      }
    } catch (err) {
      logger.error('[戳主人] 清理过期记录失败:', err)
    }
  }
}