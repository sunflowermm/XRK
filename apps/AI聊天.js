import path from 'path';
import fs from 'fs';
import { 解析向日葵插件yaml, 保存yaml } from '../components/config.js';

const _path = process.cwd();

// 全局存储
const globalAIState = new Map();
const groupPersonas = new Map();
const messageHistory = new Map();
const userCache = new Map();

// 目录路径
const PERSONAS_DIR = path.join(_path, 'plugins/XRK/config/ai-assistant/personas');
const EMOTIONS_DIR = path.join(_path, 'plugins/XRK/config/ai-assistant');
const TEMP_IMAGE_DIR = path.join(_path, 'data/temp/ai_images');
let emotionImages = {};

// 配置和人设
let config = null;
let personas = {};

// 表情包类型
const EMOTION_TYPES = ['开心', '惊讶', '伤心', '大笑', '害怕', '生气'];

// 工具函数：生成随机范围数字
function randomRange(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export class XRKAIAssistant extends plugin {
  constructor() {
    super({
      name: 'XRK-AI助手',
      dsc: '智能AI助手，支持群管理、识图等',
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
会根据聊天氛围选择合适的表情和互动方式。`);
    }
    
    // 加载人设
    personas = await this.loadPersonas();
    
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

  /** 判断是否触发AI */
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

  /** 处理AI - 调用工作流 */
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
      
      // 构建上下文
      const context = {
        e,
        persona,
        question,
        isGlobalTrigger,
        messageHistory: messageHistory.get(e.group_id) || [],
        getEmotionImage: (emotion) => this.getRandomEmotionImage(emotion),
        getBotRole: () => this.getBotRole(e),
        config,
        dateStr: this.getCurrentDateStr(),
        userCache
      };
      
      // 调用工作流
      const result = await this.callAIStream(
        {
          baseUrl: config.ai?.baseUrl,
          apiKey: config.ai?.apiKey,
          model: config.ai?.chatModel || 'gpt-3.5-turbo',
          temperature: config.ai?.temperature || 0.8,
          max_tokens: config.ai?.max_tokens || 6000,
          top_p: config.ai?.top_p || 0.9,
          presence_penalty: config.ai?.presence_penalty || 0.6,
          frequency_penalty: config.ai?.frequency_penalty || 0.6
        },
        'XRKChat', // 工作流名称
        context
      );
      
      if (!result.success) {
        logger.error(`[XRK-AI] 工作流执行失败: ${result.error}`);
        if (!isGlobalTrigger) {
          await e.reply('抱歉，处理消息时出现了问题');
        }
        return !isGlobalTrigger;
      }
      
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
      
      const result = await this.callAI(messages, {
        baseUrl: config.ai?.baseUrl,
        apiKey: config.ai?.apiKey,
        model: config.ai?.visionModel
      });
      
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
      
      const { pipeline } = await import('stream');
      const { promisify } = await import('util');
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
      const FormData = (await import('form-data')).default;
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

  /** 获取当前时间字符串 */
  getCurrentDateStr() {
    const now = new Date();
    return `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 ${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
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

  /** 显示状态 */
  async showStatus(e) {
    const emotionStats = Object.entries(emotionImages)
      .map(([emotion, images]) => `${emotion}:${images.length}张`)
      .join(' ');
    
    const status = [
      `【AI助手运行状态】`,
      `• 消息缓存：${messageHistory.size}个群`,
      `• 用户缓存：${userCache.size}条`,
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

  /** 清理缓存 */
  cleanupCache() {
    const now = Date.now();
    
    // 清理消息历史
    for (const [groupId, messages] of messageHistory.entries()) {
      const filtered = messages.filter(msg => now - msg.time < 1800000);
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