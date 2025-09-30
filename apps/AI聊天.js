import path from 'path';
import YAML from 'yaml';
import fetch from 'node-fetch';
import schedule from 'node-schedule';
import fs from 'fs';
import FormData from 'form-data';
import { promisify } from 'util';
import { pipeline } from 'stream';
import { 解析向日葵插件yaml, 保存yaml } from '../components/config.js';

const _path = process.cwd();

// 全局存储
const scheduledTasks = new Map();
const globalAIState = new Map();
const groupPersonas = new Map();
const messageHistory = new Map();
const userCache = new Map();

// 目录路径
const PERSONAS_DIR = path.join(_path, 'plugins/XRK/config/ai-assistant/personas');
const EMOTIONS_DIR = path.join(_path, 'plugins/XRK/config/ai-assistant');
const TASKS_PATH = path.join(_path, 'data/xrk-ai-tasks.yaml');
const TEMP_IMAGE_DIR = path.join(_path, 'data/temp/ai_images');
let emotionImages = {};

// 配置和人设
let config = null;
let personas = {};

// 表情包类型
const EMOTION_TYPES = ['开心', '惊讶', '伤心', '大笑', '害怕', '生气'];

// 表情回应映射
const EMOJI_REACTIONS = {
  '开心': ['4', '14', '21', '28', '76', '79', '99', '182', '201', '290'],
  '惊讶': ['26', '32', '97', '180', '268', '289'],
  '伤心': ['5', '9', '106', '111', '173', '174'],
  '大笑': ['4', '12', '28', '101', '182', '281'],
  '害怕': ['26', '27', '41', '96'],
  '喜欢': ['42', '63', '85', '116', '122', '319'],
  '爱心': ['66', '122', '319'],
  '生气': ['8', '23', '39', '86', '179', '265']
};

// 工具函数：生成随机范围数字
function randomRange(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export class XRKAIAssistant extends plugin {
  constructor() {
    super({
      name: 'XRK-AI助手',
      dsc: '智能AI助手，支持群管理、定时任务、识图等',
      event: 'message',
      priority: 99999,
      rule: [
        {
          reg: '.*',
          fnc: 'handleMessage',
          log: false
        }
      ]
    });
    
    this.config = 解析向日葵插件yaml();
    config = this.config;
  }

  /** 初始化 */
  async init() {
    // 创建目录
    await Bot.mkdir(PERSONAS_DIR);
    await Bot.mkdir(TEMP_IMAGE_DIR);
    
    // 创建表情包目录
    for (const emotion of EMOTION_TYPES) {
      const emotionDir = path.join(EMOTIONS_DIR, emotion);
      await Bot.mkdir(emotionDir);
    }
    
    // 加载表情包图片
    await this.loadEmotionImages();
    
    // 创建默认人设
    const defaultPersonaPath = path.join(PERSONAS_DIR, 'assistant.txt');
    if (!await Bot.fileExists(defaultPersonaPath)) {
      await Bot.writeFile(defaultPersonaPath, `我是${Bot.nickname}，一个智能AI助手。
我会认真观察群聊，适时发表评论和互动。
喜欢用表情回应别人的消息，也会戳一戳活跃气氛。
对不同的人有不同的态度，记得每个人的名字。
会根据聊天氛围选择合适的表情和互动方式。
我需要每天签到，感谢用户的提醒。`);
    }
    
    // 加载人设
    personas = await this.loadPersonas();
    
    // 加载定时任务
    await this.loadScheduledTasks();
    
    // 定期清理缓存
    setInterval(() => this.cleanupCache(), 300000); // 5分钟
    
    logger.info('[XRK-AI] AI助手初始化完成');
  }

  /** 加载表情包图片 */
  async loadEmotionImages() {
    for (const emotion of EMOTION_TYPES) {
      const emotionDir = path.join(EMOTIONS_DIR, emotion);
      try {
        const files = await fs.promises.readdir(emotionDir);
        const imageFiles = files.filter(file => 
          /\.(jpg|jpeg|png|gif)$/i.test(file)
        );
        emotionImages[emotion] = imageFiles.map(file => 
          path.join(emotionDir, file)
        );
      } catch (err) {
        emotionImages[emotion] = [];
      }
    }
  }

  /** 获取随机表情图片 */
  getRandomEmotionImage(emotion) {
    const images = emotionImages[emotion];
    if (!images || images.length === 0) return null;
    return images[Math.floor(Math.random() * images.length)];
  }

  /** 主消息处理器 */
  async handleMessage(e) {
    try {
      // 记录消息历史
      this.recordMessageHistory(e);
      
      // 管理命令
      if (e.isMaster && e.msg?.startsWith('#AI')) {
        return await this.handleAdminCommands(e);
      }

      // AI处理
      if (await this.shouldTriggerAI(e)) {
        return await this.processAI(e);
      }
    } catch (error) {
      logger.error(`[XRK-AI] 消息处理错误: ${error.message}`);
    }
    
    return false;
  }

  /** 加载人设 */
  async loadPersonas() {
    const personasMap = {};
    try {
      const files = await Bot.glob(path.join(PERSONAS_DIR, '*.txt'));
      for (const file of files) {
        const name = path.basename(file, '.txt');
        personasMap[name] = await Bot.readFile(file, 'utf8');
      }
    } catch (error) {
      logger.error(`[XRK-AI] 加载人设失败: ${error.message}`);
    }
    return personasMap;
  }

  /** 记录消息历史 */
  recordMessageHistory(e) {
    if (!e.isGroup) return;
    
    try {
      const groupId = e.group_id;
      if (!messageHistory.has(groupId)) {
        messageHistory.set(groupId, []);
      }
      
      const history = messageHistory.get(groupId);
      let cqMessage = e.raw_message || '';
      
      if (e.message && Array.isArray(e.message)) {
        cqMessage = e.message.map(seg => {
          switch (seg.type) {
            case 'text':
              return seg.text;
            case 'image':
              return `[图片]`;
            case 'at':
              return `[CQ:at,qq=${seg.qq}]`;
            case 'reply':
              return `[CQ:reply,id=${seg.id}]`;
            default:
              return '';
          }
        }).join('');
      }
      
      history.push({
        user_id: e.user_id,
        nickname: e.sender?.card || e.sender?.nickname || '未知',
        role: e.sender?.role || 'member',
        message: cqMessage,
        message_id: e.message_id,
        time: Date.now(),
        hasImage: e.img?.length > 0
      });
      
      if (history.length > 30) {
        history.shift();
      }
    } catch (error) {
      logger.error(`[XRK-AI] 记录消息历史失败: ${error.message}`);
    }
  }

  /** 判断是否触发AI - 修复核心逻辑 */
  async shouldTriggerAI(e) {
    // 检查是否在白名单中（群组或用户）
    const isInWhitelist = () => {
      if (e.isGroup) {
        const groupWhitelist = (config.ai?.whitelist?.groups || []).map(id => Number(id));
        return groupWhitelist.includes(Number(e.group_id));
      } else {
        const userWhitelist = (config.ai?.whitelist?.users || []).map(id => Number(id));
        return userWhitelist.includes(Number(e.user_id));
      }
    };
    
    // 1. 被@时触发（需要在白名单中）
    if (e.atBot) {
      return isInWhitelist();
    }
    
    // 2. 前缀触发（需要在白名单中）
    const triggerPrefix = config.ai?.triggerPrefix;
    if (triggerPrefix !== undefined && triggerPrefix !== null && triggerPrefix !== '') {
      if (e.msg?.startsWith(triggerPrefix)) {
        return isInWhitelist();
      }
    }
    
    // 3. 全局AI触发（只在全局白名单群中）
    if (!e.isGroup) return false;
    
    const globalWhitelist = (config.ai?.globalWhitelist || []).map(id => Number(id));
    const groupIdNum = Number(e.group_id);
    
    if (!globalWhitelist.includes(groupIdNum)) {
      return false;
    }
    
    // 全局AI状态管理
    const groupId = e.group_id;
    const state = globalAIState.get(groupId) || { 
      lastTrigger: 0, 
      messageCount: 0,
      lastMessageTime: 0,
      activeUsers: new Set()
    };
    
    const now = Date.now();
    
    // 重置计数（60秒内的消息才计数）
    if (now - state.lastMessageTime > 60000) {
      state.messageCount = 1;
      state.activeUsers.clear();
      state.activeUsers.add(e.user_id);
    } else {
      state.messageCount++;
      state.activeUsers.add(e.user_id);
    }
    state.lastMessageTime = now;
    
    // 触发条件优化
    const cooldown = (config.ai?.globalAICooldown || 300) * 1000;
    const chance = config.ai?.globalAIChance || 0.05;
    
    // 满足以下条件时触发：
    // 1. 冷却时间已过
    // 2. 有足够的消息量（3条以上）
    // 3. 有多个人参与（2人以上）或消息量达到8条
    // 4. 通过概率判断
    const canTrigger = now - state.lastTrigger > cooldown && 
                       (state.messageCount >= 3 && state.activeUsers.size >= 2 || state.messageCount >= 8);
    
    if (canTrigger && Math.random() < chance) {
      state.lastTrigger = now;
      state.messageCount = 0;
      state.activeUsers.clear();
      globalAIState.set(groupId, state);
      logger.info(`[XRK-AI] 全局AI触发 - 群:${groupId}`);
      return true;
    }
    
    globalAIState.set(groupId, state);
    return false;
  }

  /** 处理AI */
  async processAI(e) {
    try {
      const groupId = e.group_id || `private_${e.user_id}`;
      const persona = this.getCurrentPersona(groupId);
      
      // 判断是否为全局触发
      const isGlobalTrigger = !e.atBot && 
        (config.ai?.triggerPrefix === undefined || 
         config.ai?.triggerPrefix === null || 
         config.ai?.triggerPrefix === '' || 
         !e.msg?.startsWith(config.ai.triggerPrefix));
      
      let question = await this.processMessageContent(e);
      
      // 如果是主动触发但没有内容
      if (!isGlobalTrigger && !question && !e.img?.length) {
        const emotionImage = this.getRandomEmotionImage('惊讶');
        if (emotionImage) {
          await e.reply(segment.image(emotionImage));
          await Bot.sleep(300);
        }
        await e.reply('有什么需要帮助的吗？');
        return true;
      }
      
      const messages = await this.buildChatContext(e, persona, question, isGlobalTrigger);
      const response = await this.callAI(messages);
      
      if (!response) {
        // 全局触发失败时静默处理
        if (isGlobalTrigger) {
          logger.debug('[XRK-AI] 全局AI响应失败，静默处理');
          return false;
        }
        return true;
      }

      await this.processAIResponse(e, response);
      return true;
    } catch (error) {
      logger.error(`[XRK-AI] AI处理失败: ${error.message}`);
      return false;
    }
  }

  /** 处理消息内容（包含识图） */
  async processMessageContent(e) {
    let content = '';
    const message = e.message;
    
    if (!Array.isArray(message)) {
      return e.msg || '';
    }
    
    try {
      // 处理回复
      if (e.source && e.getReply) {
        try {
          const reply = await e.getReply();
          if (reply) {
            const nickname = reply.sender?.card || reply.sender?.nickname || '未知';
            content += `[回复${nickname}的"${reply.raw_message.substring(0, 30)}..."] `;
          }
        } catch {}
      }
      
      // 处理消息段
      for (const seg of message) {
        switch (seg.type) {
          case 'text':
            content += seg.text;
            break;
          case 'at':
            if (seg.qq != e.self_id) {
              try {
                const member = e.group?.pickMember(seg.qq);
                const info = await member?.getInfo();
                const nickname = info?.card || info?.nickname || seg.qq;
                content += `@${nickname} `;
              } catch {
                content += `@${seg.qq} `;
              }
            }
            break;
          case 'image':
            const desc = await this.processImage(seg.url || seg.file);
            content += `[图片:${desc}] `;
            break;
        }
      }
      
      // 清理触发前缀
      if (config.ai?.triggerPrefix && config.ai.triggerPrefix !== '') {
        content = content.replace(new RegExp(`^${config.ai.triggerPrefix}`), '');
      }
      
      return content.trim();
    } catch (error) {
      logger.error(`[XRK-AI] 处理消息内容失败: ${error.message}`);
      return e.msg || '';
    }
  }

  /** 处理图片（识图功能） */
  async processImage(imageUrl) {
    if (!imageUrl || !config.ai?.visionModel) {
      return '无法识别';
    }
    
    let tempFilePath = null;
    try {
      // 下载图片
      tempFilePath = await this.downloadImage(imageUrl);
      
      // 上传到API
      const uploadedUrl = await this.uploadImageToAPI(tempFilePath);
      
      // 识图
      const messages = [
        {
          role: 'system',
          content: '请详细描述这张图片的内容，包括主要对象、场景、颜色、氛围等'
        },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: uploadedUrl }
            }
          ]
        }
      ];
      
      const result = await this.callAI(messages, config.ai.visionModel);
      return result || '识图失败';
      
    } catch (error) {
      logger.error(`[XRK-AI] 图片处理失败: ${error.message}`);
      return '图片处理失败';
    } finally {
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch {}
      }
    }
  }

  /** 下载图片 */
  async downloadImage(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`下载失败: ${response.statusText}`);
      
      const filename = `temp_${Date.now()}_${Math.random().toString(36).substring(7)}.png`;
      const filePath = path.join(TEMP_IMAGE_DIR, filename);
      
      await promisify(pipeline)(response.body, fs.createWriteStream(filePath));
      return filePath;
    } catch (error) {
      throw new Error(`图片下载失败: ${error.message}`);
    }
  }

  /** 上传图片到API */
  async uploadImageToAPI(filePath) {
    if (!config.ai?.fileUploadUrl) {
      throw new Error('未配置文件上传URL');
    }
    
    try {
      const form = new FormData();
      const fileBuffer = await fs.promises.readFile(filePath);
      form.append('file', fileBuffer, {
        filename: path.basename(filePath),
        contentType: 'image/png'
      });
      
      const response = await fetch(config.ai.fileUploadUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.ai.apiKey}`,
          ...form.getHeaders()
        },
        body: form
      });
      
      if (!response.ok) {
        throw new Error(`上传失败: ${response.statusText}`);
      }
      
      const result = await response.json();
      return result.data?.url || result.url;
    } catch (error) {
      throw new Error(`图片上传失败: ${error.message}`);
    }
  }

  /** 构建聊天上下文 */
  async buildChatContext(e, persona, question, isGlobalTrigger = false) {
    const messages = [];
    const now = new Date();
    const dateStr = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 ${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
    
    messages.push({ 
      role: 'system', 
      content: await this.buildSystemPrompt(e, persona, dateStr, isGlobalTrigger) 
    });
    
    if (e.isGroup) {
      const history = messageHistory.get(e.group_id) || [];
      
      if (isGlobalTrigger) {
        // 全局触发时，提供更多历史
        const recentMessages = history.slice(-15);
        if (recentMessages.length > 0) {
          messages.push({
            role: 'user',
            content: `[群聊记录]\n${recentMessages.map(msg => 
              `${msg.nickname}(${msg.user_id})[${msg.message_id}]: ${msg.message}`
            ).join('\n')}\n\n请对当前话题发表你的看法，要自然且有自己的观点。`
          });
        }
      } else {
        // 主动触发时
        const currentIndex = history.findIndex(msg => msg.message_id === e.message_id);
        let relevantHistory = [];
        
        if (currentIndex > 0) {
          const historyCount = Math.min(config.ai?.historyLimit || 10, currentIndex);
          relevantHistory = history.slice(Math.max(0, currentIndex - historyCount), currentIndex);
        } else if (currentIndex === -1 && history.length > 0) {
          relevantHistory = history.slice(-(config.ai?.historyLimit || 10));
        }
        
        if (relevantHistory.length > 0) {
          messages.push({
            role: 'user',
            content: `[群聊记录]\n${relevantHistory.map(msg => 
              `${msg.nickname}(${msg.user_id})[${msg.message_id}]: ${msg.message}`
            ).join('\n')}`
          });
        }
        
        const userInfo = e.sender?.card || e.sender?.nickname || '未知';
        messages.push({
          role: 'user',
          content: `[当前消息]\n${userInfo}(${e.user_id})[${e.message_id}]: ${question}`
        });
      }
    } else {
      // 私聊
      const userInfo = e.sender?.nickname || '未知';
      messages.push({
        role: 'user',
        content: `${userInfo}(${e.user_id}): ${question}`
      });
    }
    
    return messages;
  }

  /** 构建系统提示 */
  async buildSystemPrompt(e, persona, dateStr, isGlobalTrigger) {
    const botRole = await this.getBotRole(e);
    
    const systemPrompt = `【人设设定】
${persona}

【身份信息】
名字：${Bot.nickname}
QQ号：${e.self_id}
${e.isGroup ? `群名：${e.group?.group_name || '未知'}
群号：${e.group_id}
身份：${botRole}` : ''}

【时间信息】
当前时间：${dateStr}

【触发方式】
${isGlobalTrigger ? '观察群聊后主动发言' : '被召唤回复'}

【基础规则】
1. 你是一个真实的QQ用户，不是AI助手
2. 说话要自然、简洁、有个性
3. 最多使用一个竖线分隔符(|)，也就是最多发送两条消息
4. 每条消息不要太长，像正常聊天一样
5. 适当使用表情包和互动功能

【表情包系统】
在文字中插入以下标记来发送表情包（一次对话只能使用一个表情包）：
[开心] [惊讶] [伤心] [大笑] [害怕] [生气]
重要：每次回复最多只能使用一个表情包标记！

【互动功能】
[CQ:at,qq=QQ号] - @某人（确保QQ号存在）
[CQ:poke,qq=QQ号] - 戳一戳某人
[CQ:reply,id=消息ID] - 回复某条消息
[回应:消息ID:表情类型] - 给消息添加表情回应
[点赞:QQ号:次数] - 给某人点赞（1-50次）
[签到] - 执行群签到
${botRole !== '成员' ? `[禁言:QQ号:秒数] - 禁言
[解禁:QQ号] - 解除禁言
[精华:消息ID] - 设置精华消息
[公告:内容] - 发布群公告` : ''}
[提醒:年-月-日 时:分:内容] - 设置定时提醒

【重要限制】
1. 每次回复最多只能发一个表情包
2. 最多使用一个竖线(|)分隔，也就是最多两条消息
3. @人之前要确认QQ号是否在群聊记录中出现过
4. 不要重复使用相同的功能

【注意事项】
${isGlobalTrigger ? '1. 主动发言要有新意，不要重复他人观点\n2. 可以随机戳一戳活跃的成员\n3. 语气要自然，像普通群员一样' : '1. 回复要针对性强，不要答非所问\n2. 被召唤时更要积极互动'}
3. @人时只使用出现在群聊记录中的QQ号
4. 多使用戳一戳和表情回应来增加互动性
${e.isMaster ? '5. 对主人要特别友好和尊重' : ''}`;

    return systemPrompt;
  }

  /** 获取机器人角色 */
  async getBotRole(e) {
    if (!e.isGroup) return '';
    
    const cacheKey = `bot_role_${e.group_id}`;
    const cached = userCache.get(cacheKey);
    if (cached && Date.now() - cached.time < 300000) {
      return cached.role;
    }
    
    try {
      const member = e.group.pickMember(e.self_id);
      const info = await member.getInfo();
      const role = info.role === 'owner' ? '群主' : 
                   info.role === 'admin' ? '管理员' : '成员';
      
      userCache.set(cacheKey, { role, time: Date.now() });
      return role;
    } catch {
      return '成员';
    }
  }

  /** 处理AI响应 */
  async processAIResponse(e, response) {
    try {
      // 使用竖线分割响应，最多两段
      const segments = response.split('|').map(s => s.trim()).filter(s => s).slice(0, 2);
      
      // 统计总的表情包数量，确保只发一个
      let emotionSent = false;
      
      for (let i = 0; i < segments.length; i++) {
        const responseSegment = segments[i];
        
        // 解析当前段落
        const { textParts, emotions, functions } = this.parseResponseSegment(responseSegment);
        
        // 只发送第一个表情包
        if (!emotionSent && emotions.length > 0) {
          const emotionImage = this.getRandomEmotionImage(emotions[0]);
          if (emotionImage) {
            await e.reply(segment.image(emotionImage));
            emotionSent = true;
            await Bot.sleep(300);
          }
        }
        
        // 发送文本内容
        if (textParts.length > 0) {
          const msgSegments = [];
          for (const part of textParts) {
            const cqSegments = await this.parseCQCodes(part, e);
            msgSegments.push(...cqSegments);
          }
          
          if (msgSegments.length > 0) {
            await e.reply(msgSegments, Math.random() > 0.5);
          }
        }
        
        // 执行功能
        for (const func of functions) {
          await this.executeFunction(func, e);
        }
        
        // 延迟到下一个segment
        if (i < segments.length - 1) {
          await Bot.sleep(randomRange(800, 1500));
        }
      }
    } catch (error) {
      logger.error(`[XRK-AI] 处理AI响应失败: ${error.message}`);
    }
  }

  /** 解析响应段落 */
  parseResponseSegment(segmentText) {
    const textParts = [];
    const emotions = [];
    const functions = [];
    
    // 提取功能
    const functionPatterns = [
      { regex: /\[回应:([^:]+):([^\]]+)\]/g, type: 'emojiReaction' },
      { regex: /\[点赞:(\d+):(\d+)\]/g, type: 'thumbUp' },
      { regex: /\[签到\]/g, type: 'sign' },
      { regex: /\[禁言:(\d+):(\d+)\]/g, type: 'mute' },
      { regex: /\[解禁:(\d+)\]/g, type: 'unmute' },
      { regex: /\[精华:([^\]]+)\]/g, type: 'essence' },
      { regex: /\[公告:([^\]]+)\]/g, type: 'notice' },
      { regex: /\[提醒:([^:]+):([^:]+):([^\]]+)\]/g, type: 'reminder' }
    ];
    
    let cleanedSegment = segmentText;
    
    functionPatterns.forEach(({ regex, type }) => {
      let match;
      regex.lastIndex = 0; // 重置正则表达式
      while ((match = regex.exec(segmentText))) {
        functions.push({ type, params: match.slice(1) });
        cleanedSegment = cleanedSegment.replace(match[0], '');
      }
    });
    
    // 提取表情包（只提取第一个）
    const emotionRegex = /\[(开心|惊讶|伤心|大笑|害怕|生气)\]/g;
    let emotionMatch = emotionRegex.exec(cleanedSegment);
    if (emotionMatch) {
      emotions.push(emotionMatch[1]);
      cleanedSegment = cleanedSegment.replace(emotionRegex, '');
    }
    
    // 剩余的文本内容
    if (cleanedSegment.trim()) {
      textParts.push(cleanedSegment.trim());
    }
    
    return { textParts, emotions, functions };
  }

  /** 解析CQ码 */
  async parseCQCodes(text, e) {
    const segments = [];
    const parts = text.split(/(\[CQ:[^\]]+\])/);
    
    for (const part of parts) {
      if (part.startsWith('[CQ:')) {
        const cqSegment = await this.parseSingleCQCode(part, e);
        if (cqSegment) {
          segments.push(cqSegment);
        }
      } else if (part) {
        segments.push(part);
      }
    }
    
    return segments;
  }

  /** 解析单个CQ码 */
  async parseSingleCQCode(cqCode, e) {
    const match = cqCode.match(/\[CQ:(\w+)(?:,([^\]]+))?\]/);
    if (!match) return null;
    
    const [, type, params] = match;
    const paramObj = {};
    
    if (params) {
      params.split(',').forEach(p => {
        const [key, value] = p.split('=');
        paramObj[key] = value;
      });
    }
    
    switch (type) {
      case 'at':
        if (e.isGroup && paramObj.qq) {
          const history = messageHistory.get(e.group_id) || [];
          const userExists = history.some(msg => String(msg.user_id) === String(paramObj.qq));
          
          if (userExists) {
            try {
              const member = e.group.pickMember(paramObj.qq);
              await member.getInfo();
              return segment.at(paramObj.qq);
            } catch {
              return null;
            }
          }
        }
        return null;
        
      case 'poke':
        if (e.isGroup && paramObj.qq) {
          try {
            await e.group.pokeMember(paramObj.qq);
            return null;
          } catch {
            return null;
          }
        }
        return null;
        
      case 'reply':
        return segment.reply(paramObj.id);
        
      case 'image':
        return segment.image(paramObj.file);
        
      default:
        return null;
    }
  }

  /** 执行功能 */
  async executeFunction(func, e) {
    if (!e.isGroup && func.type !== 'reminder') return;
    
    try {
      switch (func.type) {
        case 'emojiReaction':
          const [msgId, emojiType] = func.params;
          if (msgId && EMOJI_REACTIONS[emojiType]) {
            const emojiIds = EMOJI_REACTIONS[emojiType];
            const emojiId = emojiIds[Math.floor(Math.random() * emojiIds.length)];
            await e.group.setEmojiLike(msgId, emojiId);
          }
          break;
          
        case 'thumbUp':
          const [qq, count] = func.params;
          if (e.isGroup) {
            const thumbCount = Math.min(parseInt(count) || 1, 50);
            await e.group.pickMember(qq).thumbUp(thumbCount);
          }
          break;
          
        case 'sign':
          if (e.isGroup) {
            await e.group.sign();
          }
          break;
          
        case 'mute':
          if (await this.checkPermission(e, 'mute')) {
            await e.group.muteMember(func.params[0], parseInt(func.params[1]));
          }
          break;
          
        case 'unmute':
          if (await this.checkPermission(e, 'mute')) {
            await e.group.muteMember(func.params[0], 0);
          }
          break;
          
        case 'essence':
          if (await this.checkPermission(e, 'admin')) {
            await e.group.setEssence(func.params[0]);
          }
          break;
          
        case 'notice':
          if (await this.checkPermission(e, 'admin')) {
            await e.group.sendNotice(func.params[0]);
          }
          break;
          
        case 'reminder':
          await this.createReminder(e, func.params);
          break;
      }
    } catch (err) {
      logger.error(`[XRK-AI] 功能执行失败: ${func.type} - ${err.message}`);
    }
  }

  /** 检查权限 */
  async checkPermission(e, permission) {
    if (!e.isGroup) return false;
    if (e.isMaster) return true;
    
    const role = await this.getBotRole(e);
    
    switch (permission) {
      case 'mute':
      case 'admin':
        return role === '群主' || role === '管理员';
      case 'owner':
        return role === '群主';
      default:
        return false;
    }
  }

  /** 创建提醒 - 修复循环触发问题 */
  async createReminder(e, params) {
    try {
      const [dateStr, timeStr, content] = params;
      
      const [year, month, day] = dateStr.split('-').map(Number);
      const [hour, minute] = timeStr.split(':').map(Number);
      
      const reminderTime = new Date(year, month - 1, day, hour, minute, 0);
      
      if (reminderTime <= new Date()) {
        await e.reply('提醒时间必须在未来');
        return;
      }
      
      const task = {
        id: `reminder_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        type: 'reminder',
        creator: e.user_id,
        group: e.group_id,
        private: !e.isGroup ? e.user_id : null,
        time: reminderTime.toISOString(),
        content: content,
        created: new Date().toISOString()
      };
      
      await this.saveTask(task);
      this.scheduleTask(task);
      
      const emotionImage = this.getRandomEmotionImage('开心');
      if (emotionImage) {
        await e.reply(segment.image(emotionImage));
      }
      await e.reply(`已设置提醒：${dateStr} ${timeStr} "${content}"`);
    } catch (error) {
      logger.error(`[XRK-AI] 创建提醒失败: ${error.message}`);
      await e.reply('设置提醒失败，请检查格式');
    }
  }

  /** 管理命令处理 */
  async handleAdminCommands(e) {
    const msg = e.msg;
    
    if (msg === '#AI帮助') {
      return await this.showHelp(e);
    }
    else if (/^#AI切换人设\s*(.+)$/.test(msg)) {
      const persona = msg.match(/^#AI切换人设\s*(.+)$/)[1];
      return await this.switchPersona(e, persona);
    }
    else if (msg === '#AI当前人设') {
      return await this.showCurrentPersona(e);
    }
    else if (msg === '#AI人设列表') {
      return await this.listPersonas(e);
    }
    else if (/^#AI添加全局\s*(\d+)?$/.test(msg)) {
      const groupId = msg.match(/(\d+)$/)?.[1] || e.group_id;
      return await this.addGlobalWhitelist(e, groupId);
    }
    else if (/^#AI移除全局\s*(\d+)?$/.test(msg)) {
      const groupId = msg.match(/(\d+)$/)?.[1] || e.group_id;
      return await this.removeGlobalWhitelist(e, groupId);
    }
    else if (msg === '#AI查看全局') {
      return await this.showGlobalWhitelist(e);
    }
    else if (msg === '#AI重载人设') {
      personas = await this.loadPersonas();
      await this.loadEmotionImages();
      await e.reply('人设和表情包已重新加载');
      return true;
    }
    else if (msg === '#AI清理任务') {
      return await this.clearExpiredTasks(e);
    }
    else if (msg === '#AI状态') {
      return await this.showStatus(e);
    }
    
    return false;
  }

  /** 显示帮助 */
  async showHelp(e) {
    const help = `【AI助手管理命令】
#AI帮助 - 显示此帮助
#AI切换人设 <人设名> - 切换人设
#AI当前人设 - 查看当前人设
#AI人设列表 - 查看可用人设
#AI添加全局 [群号] - 添加全局AI
#AI移除全局 [群号] - 移除全局AI
#AI查看全局 - 查看全局AI列表
#AI重载人设 - 重新加载人设和表情包
#AI清理任务 - 清理过期任务
#AI状态 - 查看运行状态

【功能说明】
• 触发方式：@机器人、前缀触发
• 全局AI：在白名单群自动参与聊天
• 触发概率：${(config.ai?.globalAIChance || 0.05) * 100}%
• 冷却时间：${config.ai?.globalAICooldown || 300}秒
• 表情回应：AI自主决定回应表情
• 识图功能：发送图片时自动识别`;
    
    await e.reply(help);
    return true;
  }

  /** 切换人设 */
  async switchPersona(e, personaName) {
    if (!personas[personaName]) {
      await e.reply(`未找到人设"${personaName}"\n可用：${Object.keys(personas).join('、')}`);
      return true;
    }
    
    const groupId = e.group_id || `private_${e.user_id}`;
    groupPersonas.set(groupId, personaName);
    
    const emotionImage = this.getRandomEmotionImage('开心');
    if (emotionImage) {
      await e.reply(segment.image(emotionImage));
    }
    await e.reply(`已切换到人设"${personaName}"`);
    return true;
  }

  /** 显示当前人设 */
  async showCurrentPersona(e) {
    const groupId = e.group_id || `private_${e.user_id}`;
    const personaName = this.getCurrentPersonaName(groupId);
    const content = personas[personaName];
    
    await e.reply(`当前人设：${personaName}\n\n${content.substring(0, 100)}...`);
    return true;
  }

  /** 人设列表 */
  async listPersonas(e) {
    const list = Object.keys(personas).map(name => 
      `【${name}】\n${personas[name].substring(0, 50)}...`
    ).join('\n\n');
    
    await e.reply(`可用人设列表：\n\n${list}`);
    return true;
  }

  /** 添加全局AI */
  async addGlobalWhitelist(e, groupId) {
    if (!groupId || groupId === 'undefined') {
      await e.reply('请指定群号或在群内使用');
      return true;
    }
    
    const cfg = 解析向日葵插件yaml();
    if (!cfg.ai) cfg.ai = {};
    if (!cfg.ai.globalWhitelist) cfg.ai.globalWhitelist = [];
    
    const gid = Number(groupId);
    if (!cfg.ai.globalWhitelist.includes(gid)) {
      cfg.ai.globalWhitelist.push(gid);
      await 保存yaml(path.join(_path, 'data/xrkconfig/config.yaml'), cfg);
      config = cfg;
      
      const emotionImage = this.getRandomEmotionImage('开心');
      if (emotionImage) {
        await e.reply(segment.image(emotionImage));
      }
      await e.reply(`已添加群${gid}到全局AI白名单`);
    } else {
      await e.reply(`群${gid}已在白名单中`);
    }
    return true;
  }

  /** 移除全局AI */
  async removeGlobalWhitelist(e, groupId) {
    if (!groupId || groupId === 'undefined') {
      await e.reply('请指定群号或在群内使用');
      return true;
    }
    
    const cfg = 解析向日葵插件yaml();
    if (cfg.ai?.globalWhitelist) {
      const gid = Number(groupId);
      cfg.ai.globalWhitelist = cfg.ai.globalWhitelist.filter(g => g !== gid);
      await 保存yaml(path.join(_path, 'data/xrkconfig/config.yaml'), cfg);
      config = cfg;
      
      const emotionImage = this.getRandomEmotionImage('伤心');
      if (emotionImage) {
        await e.reply(segment.image(emotionImage));
      }
      await e.reply(`已移除群${gid}的全局AI`);
    }
    return true;
  }

  /** 查看全局AI白名单 */
  async showGlobalWhitelist(e) {
    const list = config.ai?.globalWhitelist || [];
    const msg = list.length ? 
      `全局AI白名单：\n${list.map(g => `• ${g}`).join('\n')}` :
      '全局AI白名单为空';
    
    await e.reply(msg);
    return true;
  }

  /** 清理过期任务 */
  async clearExpiredTasks(e) {
    try {
      const tasks = await this.loadTasks();
      const now = Date.now();
      let cleared = 0;
      
      for (const [id, task] of Object.entries(tasks)) {
        if (new Date(task.time) < now) {
          delete tasks[id];
          
          // 取消已调度的任务
          const job = scheduledTasks.get(id);
          if (job) {
            job.cancel();
            scheduledTasks.delete(id);
          }
          
          cleared++;
        }
      }
      
      await Bot.writeFile(TASKS_PATH, YAML.stringify(tasks));
      
      const emotionImage = this.getRandomEmotionImage('开心');
      if (emotionImage) {
        await e.reply(segment.image(emotionImage));
      }
      await e.reply(`已清理${cleared}个过期任务`);
    } catch (error) {
      logger.error(`[XRK-AI] 清理任务失败: ${error.message}`);
      await e.reply('清理任务失败');
    }
    return true;
  }

  /** 显示状态 */
  async showStatus(e) {
    const emotionStats = Object.entries(emotionImages)
      .map(([emotion, images]) => `${emotion}:${images.length}张`)
      .join(' ');
    
    const status = [
      `【AI助手运行状态】`,
      `• 消息缓存：${messageHistory.size}个群`,
      `• 用户缓存：${userCache.size}条`,
      `• 定时任务：${scheduledTasks.size}个`,
      `• 普通白名单群：${(config.ai?.whitelist?.groups || []).length}个`,
      `• 全局AI群：${(config.ai?.globalWhitelist || []).length}个`,
      `• 触发前缀：${config.ai?.triggerPrefix || '无'}`,
      `• 触发概率：${(config.ai?.globalAIChance || 0.05) * 100}%`,
      `• 冷却时间：${config.ai?.globalAICooldown || 300}秒`,
      `• 人设数量：${Object.keys(personas).length}个`,
      `• 表情包：${emotionStats}`
    ];
    
    await e.reply(status.join('\n'));
    return true;
  }

  /** 获取当前人设名 */
  getCurrentPersonaName(groupId) {
    return groupPersonas.get(groupId) || config.ai?.defaultPersona || 'assistant';
  }

  /** 获取当前人设 */
  getCurrentPersona(groupId) {
    const name = this.getCurrentPersonaName(groupId);
    return personas[name] || personas.assistant || '我是AI助手';
  }

  /** 调用AI */
  async callAI(messages, model) {
    try {
      const response = await fetch(`${config.ai?.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.ai?.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: model || config.ai?.chatModel || 'gpt-3.5-turbo',
          messages: messages,
          temperature: config.ai?.temperature || 0.8,
          max_tokens: config.ai?.max_tokens || 6000,
          top_p: config.ai?.top_p || 0.9,
          presence_penalty: config.ai?.presence_penalty || 0.6,
          frequency_penalty: config.ai?.frequency_penalty || 0.6
        }),
        timeout: 30000
      });

      if (!response.ok) {
        throw new Error(`API错误: ${response.status}`);
      }

      const result = await response.json();
      return result.choices?.[0]?.message?.content || null;
    } catch (error) {
      logger.error(`[XRK-AI] API调用失败: ${error.message}`);
      return null;
    }
  }

  /** 保存任务 */
  async saveTask(task) {
    try {
      const tasks = await this.loadTasks();
      tasks[task.id] = task;
      await Bot.writeFile(TASKS_PATH, YAML.stringify(tasks));
    } catch (error) {
      logger.error(`[XRK-AI] 保存任务失败: ${error.message}`);
      throw error;
    }
  }

  /** 加载任务 */
  async loadTasks() {
    try {
      if (!await Bot.fileExists(TASKS_PATH)) {
        await Bot.writeFile(TASKS_PATH, YAML.stringify({}));
        return {};
      }
      const content = await Bot.readFile(TASKS_PATH, 'utf8');
      return YAML.parse(content) || {};
    } catch (error) {
      logger.error(`[XRK-AI] 加载任务失败: ${error.message}`);
      return {};
    }
  }

  /** 加载定时任务 */
  async loadScheduledTasks() {
    try {
      const tasks = await this.loadTasks();
      const now = new Date();
      
      Object.values(tasks).forEach(task => {
        if (new Date(task.time) > now) {
          this.scheduleTask(task);
        }
      });
      
      logger.info(`[XRK-AI] 加载了${Object.keys(tasks).length}个定时任务`);
    } catch (error) {
      logger.error(`[XRK-AI] 加载定时任务失败: ${error.message}`);
    }
  }

  /** 调度任务 - 修复循环触发 */
  scheduleTask(task) {
    try {
      // 防止重复调度
      if (scheduledTasks.has(task.id)) {
        const existingJob = scheduledTasks.get(task.id);
        existingJob.cancel();
        scheduledTasks.delete(task.id);
      }
      
      const taskTime = new Date(task.time);
      
      const job = schedule.scheduleJob(taskTime, async () => {
        try {
          // 执行任务
          const emotionImage = this.getRandomEmotionImage('开心');
          if (emotionImage) {
            if (task.group) {
              await Bot.sendGroupMsg(task.group, segment.image(emotionImage));
            } else if (task.private) {
              await Bot.sendPrivateMsg(task.private, segment.image(emotionImage));
            }
          }
          
          const msg = `【定时提醒】${task.content}`;
          if (task.group) {
            await Bot.sendGroupMsg(task.group, msg);
          } else if (task.private) {
            await Bot.sendPrivateMsg(task.private, msg);
          }
          
          // 删除已执行的任务
          const tasks = await this.loadTasks();
          delete tasks[task.id];
          await Bot.writeFile(TASKS_PATH, YAML.stringify(tasks));
          
          // 从调度列表中移除
          scheduledTasks.delete(task.id);
          
          logger.info(`[XRK-AI] 任务${task.id}执行完成并已删除`);
        } catch (err) {
          logger.error(`[XRK-AI] 任务执行失败: ${err.message}`);
          // 即使执行失败也要清理任务
          scheduledTasks.delete(task.id);
        }
      });
      
      scheduledTasks.set(task.id, job);
      logger.info(`[XRK-AI] 任务${task.id}已调度`);
    } catch (error) {
      logger.error(`[XRK-AI] 调度任务失败: ${error.message}`);
    }
  }

  /** 清理缓存 */
  cleanupCache() {
    const now = Date.now();
    
    // 清理消息历史
    for (const [groupId, messages] of messageHistory.entries()) {
      const filtered = messages.filter(msg => now - msg.time < 1800000); // 保留30分钟
      if (filtered.length === 0) {
        messageHistory.delete(groupId);
      } else {
        messageHistory.set(groupId, filtered);
      }
    }
    
    // 清理用户缓存
    for (const [key, data] of userCache.entries()) {
      if (now - data.time > 300000) { // 5分钟
        userCache.delete(key);
      }
    }
    
    // 清理全局AI状态
    for (const [groupId, state] of globalAIState.entries()) {
      if (now - state.lastMessageTime > 3600000) { // 1小时
        globalAIState.delete(groupId);
      }
    }
    
    logger.debug(`[XRK-AI] 缓存清理完成`);
  }
}