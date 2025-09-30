import plugin from '../../../lib/plugins/plugin.js';
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

const scheduledTasks = new Map();
const globalAIState = new Map();
const groupPersonas = new Map();
const messageHistory = new Map();
const userCache = new Map();

const PERSONAS_DIR = path.join(_path, 'plugins/XRK/config/ai-assistant/personas');
const EMOTIONS_DIR = path.join(_path, 'plugins/XRK/config/ai-assistant');
const TASKS_PATH = path.join(_path, 'data/xrk-ai-tasks.yaml');
const TEMP_IMAGE_DIR = path.join(_path, 'data/temp/ai_images');

let emotionImages = {};
let config = null;
let personas = {};

const EMOTION_TYPES = ['开心', '惊讶', '伤心', '大笑', '害怕', '生气'];

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

  async init() {
    await Bot.mkdir(PERSONAS_DIR);
    await Bot.mkdir(TEMP_IMAGE_DIR);
    
    for (const emotion of EMOTION_TYPES) {
      const emotionDir = path.join(EMOTIONS_DIR, emotion);
      await Bot.mkdir(emotionDir);
    }
    
    await this.loadEmotionImages();
    
    const defaultPersonaPath = path.join(PERSONAS_DIR, 'assistant.txt');
    if (!await Bot.fileExists(defaultPersonaPath)) {
      await Bot.writeFile(defaultPersonaPath, `我是${Bot.nickname}，一个智能AI助手。
我会认真观察群聊，适时发表评论和互动。
喜欢用表情回应别人的消息，也会戳一戳活跃气氛。
对不同的人有不同的态度，记得每个人的名字。
会根据聊天氛围选择合适的表情和互动方式。
我需要每天签到，感谢用户的提醒。`);
    }
    
    personas = await this.loadPersonas();
    this.chatStream = this.getStream('XRKChat');
    
    await this.loadScheduledTasks();
    setInterval(() => this.cleanupCache(), 300000);
    
    logger.info('[XRK-AI] AI助手初始化完成');
  }

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

  getRandomEmotionImage(emotion) {
    const images = emotionImages[emotion];
    if (!images || images.length === 0) return null;
    return images[Math.floor(Math.random() * images.length)];
  }

  async handleMessage(e) {
    try {
      this.recordMessageHistory(e);
      
      if (e.isMaster && e.msg?.startsWith('#AI')) {
        return await this.handleAdminCommands(e);
      }

      if (await this.shouldTriggerAI(e)) {
        return await this.processAI(e);
      }
    } catch (error) {
      logger.error(`[XRK-AI] 消息处理错误: ${error.message}`);
    }
    
    return false;
  }

  async processAI(e) {
    try {
      const groupId = e.group_id || `private_${e.user_id}`;
      const persona = this.getCurrentPersona(groupId);
      
      const isGlobalTrigger = !e.atBot && 
        (config.ai?.triggerPrefix === undefined || 
         config.ai?.triggerPrefix === null || 
         config.ai?.triggerPrefix === '' || 
         !e.msg?.startsWith(config.ai.triggerPrefix));
      
      let question = await this.processMessageContent(e);
      
      if (!isGlobalTrigger && !question && !e.img?.length) {
        const emotionImage = this.getRandomEmotionImage('惊讶');
        if (emotionImage) {
          await e.reply(segment.image(emotionImage));
          await Bot.sleep(300);
        }
        await e.reply('有什么需要帮助的吗？');
        return true;
      }
      
      const now = new Date();
      const dateStr = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 ${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
      const botRole = await this.getBotRole(e);
      
      const context = {
        e,
        question,
        isGlobalTrigger,
        dateStr,
        botRole,
        getEmotionImage: (emotion) => this.getRandomEmotionImage(emotion),
        createReminder: async (e, params) => await this.createReminder(e, params),
        history: this.getMessageHistory(e)
      };
      
      const aiConfig = {
        baseUrl: config.ai?.baseUrl,
        apiKey: config.ai?.apiKey,
        model: config.ai?.chatModel || 'gpt-3.5-turbo',
        temperature: config.ai?.temperature || 0.8,
        max_tokens: config.ai?.max_tokens || 6000,
        top_p: config.ai?.top_p || 0.9,
        presence_penalty: config.ai?.presence_penalty || 0.6,
        frequency_penalty: config.ai?.frequency_penalty || 0.6
      };
      
      const result = await this.callAIStream(
        aiConfig,
        this.chatStream ? 'XRKChat' : null,
        this.chatStream ? persona : this.buildSystemPrompt(e, persona, dateStr, isGlobalTrigger),
        context
      );
      
      if (!result.success || !result.response) {
        if (isGlobalTrigger) {
          logger.debug('[XRK-AI] 全局AI响应失败，静默处理');
          return false;
        }
        return true;
      }

      await this.processAIResponse(e, result.response, result.executed);
      return true;
    } catch (error) {
      logger.error(`[XRK-AI] AI处理失败: ${error.message}`);
      return false;
    }
  }

  async processAIResponse(e, response, executedActions = []) {
    try {
      const segments = response.split('|').map(s => s.trim()).filter(s => s).slice(0, 2);
      
      for (const action of executedActions) {
        if (action.success && action.result) {
          const result = action.result;
          
          if (result.action === 'emotion' && result.image) {
            await e.reply(segment.image(result.image));
            await Bot.sleep(300);
          }
          
          if (result.type === 'at' && result.qq) {
            segments[0] = `${segment.at(result.qq)} ${segments[0] || ''}`;
          }
          
          if (result.type === 'reply' && result.id) {
            segments[0] = `${segment.reply(result.id)} ${segments[0] || ''}`;
          }
        }
      }
      
      for (let i = 0; i < segments.length; i++) {
        const text = segments[i];
        if (text) {
          await e.reply(text, Math.random() > 0.5);
          
          if (i < segments.length - 1) {
            await Bot.sleep(Math.floor(Math.random() * 700) + 800);
          }
        }
      }
    } catch (error) {
      logger.error(`[XRK-AI] 处理AI响应失败: ${error.message}`);
    }
  }

  getMessageHistory(e) {
    if (!e.isGroup) return [];
    
    const history = messageHistory.get(e.group_id) || [];
    const recentHistory = history.slice(-(config.ai?.historyLimit || 10));
    
    return recentHistory.map(msg => ({
      role: 'user',
      content: `${msg.nickname}(${msg.user_id}): ${msg.message}`
    }));
  }

  async createReminder(e, params) {
    try {
      const [dateStr, timeStr, content] = params;
      
      const [year, month, day] = dateStr.split('-').map(Number);
      const [hour, minute] = timeStr.split(':').map(Number);
      
      const reminderTime = new Date(year, month - 1, day, hour, minute, 0);
      
      if (reminderTime <= new Date()) {
        await e.reply('提醒时间必须在未来');
        return null;
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
      
      return { action: 'reminder', task };
    } catch (error) {
      logger.error(`[XRK-AI] 创建提醒失败: ${error.message}`);
      await e.reply('设置提醒失败，请检查格式');
      return null;
    }
  }

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

  async shouldTriggerAI(e) {
    const isInWhitelist = () => {
      if (e.isGroup) {
        const groupWhitelist = (config.ai?.whitelist?.groups || []).map(id => Number(id));
        return groupWhitelist.includes(Number(e.group_id));
      } else {
        const userWhitelist = (config.ai?.whitelist?.users || []).map(id => Number(id));
        return userWhitelist.includes(Number(e.user_id));
      }
    };
    
    if (e.atBot) {
      return isInWhitelist();
    }
    
    const triggerPrefix = config.ai?.triggerPrefix;
    if (triggerPrefix !== undefined && triggerPrefix !== null && triggerPrefix !== '') {
      if (e.msg?.startsWith(triggerPrefix)) {
        return isInWhitelist();
      }
    }
    
    if (!e.isGroup) return false;
    
    const globalWhitelist = (config.ai?.globalWhitelist || []).map(id => Number(id));
    const groupIdNum = Number(e.group_id);
    
    if (!globalWhitelist.includes(groupIdNum)) {
      return false;
    }
    
    const groupId = e.group_id;
    const state = globalAIState.get(groupId) || { 
      lastTrigger: 0, 
      messageCount: 0,
      lastMessageTime: 0,
      activeUsers: new Set()
    };
    
    const now = Date.now();
    
    if (now - state.lastMessageTime > 60000) {
      state.messageCount = 1;
      state.activeUsers.clear();
      state.activeUsers.add(e.user_id);
    } else {
      state.messageCount++;
      state.activeUsers.add(e.user_id);
    }
    state.lastMessageTime = now;
    
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

  async processMessageContent(e) {
    let content = '';
    const message = e.message;
    
    if (!Array.isArray(message)) {
      return e.msg || '';
    }
    
    try {
      if (e.source && e.getReply) {
        try {
          const reply = await e.getReply();
          if (reply) {
            const nickname = reply.sender?.card || reply.sender?.nickname || '未知';
            content += `[回复${nickname}的"${reply.raw_message.substring(0, 30)}..."] `;
          }
        } catch {}
      }
      
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
      
      if (config.ai?.triggerPrefix && config.ai.triggerPrefix !== '') {
        content = content.replace(new RegExp(`^${config.ai.triggerPrefix}`), '');
      }
      
      return content.trim();
    } catch (error) {
      logger.error(`[XRK-AI] 处理消息内容失败: ${error.message}`);
      return e.msg || '';
    }
  }

  async processImage(imageUrl) {
    if (!imageUrl || !config.ai?.visionModel) {
      return '无法识别';
    }
    
    let tempFilePath = null;
    try {
      tempFilePath = await this.downloadImage(imageUrl);
      const uploadedUrl = await this.uploadImageToAPI(tempFilePath);
      
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
        model: config.ai.visionModel
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

  getCurrentPersonaName(groupId) {
    return groupPersonas.get(groupId) || config.ai?.defaultPersona || 'assistant';
  }

  getCurrentPersona(groupId) {
    const name = this.getCurrentPersonaName(groupId);
    return personas[name] || personas.assistant || '我是AI助手';
  }

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
      this.chatStream = this.getStream('XRKChat');
      await e.reply('人设、表情包和工作流已重新加载');
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

  async showHelp(e) {
    const help = `【AI助手管理命令】
#AI帮助 - 显示此帮助
#AI切换人设 <人设名> - 切换人设
#AI当前人设 - 查看当前人设
#AI人设列表 - 查看可用人设
#AI添加全局 [群号] - 添加全局AI
#AI移除全局 [群号] - 移除全局AI
#AI查看全局 - 查看全局AI列表
#AI重载人设 - 重新加载人设、表情包和工作流
#AI清理任务 - 清理过期任务
#AI状态 - 查看运行状态

【功能说明】
• 触发方式：@机器人、前缀触发
• 全局AI：在白名单群自动参与聊天
• 触发概率：${(config.ai?.globalAIChance || 0.05) * 100}%
• 冷却时间：${config.ai?.globalAICooldown || 300}秒
• 表情回应：AI自主决定回应表情
• 识图功能：发送图片时自动识别
• 工作流：${this.chatStream ? '已加载' : '未加载'}`;
    
    await e.reply(help);
    return true;
  }

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

  async showCurrentPersona(e) {
    const groupId = e.group_id || `private_${e.user_id}`;
    const personaName = this.getCurrentPersonaName(groupId);
    const content = personas[personaName];
    
    await e.reply(`当前人设：${personaName}\n\n${content.substring(0, 100)}...`);
    return true;
  }

  async listPersonas(e) {
    const list = Object.keys(personas).map(name => 
      `【${name}】\n${personas[name].substring(0, 50)}...`
    ).join('\n\n');
    
    await e.reply(`可用人设列表：\n\n${list}`);
    return true;
  }

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

  async showGlobalWhitelist(e) {
    const list = config.ai?.globalWhitelist || [];
    const msg = list.length ? 
      `全局AI白名单：\n${list.map(g => `• ${g}`).join('\n')}` :
      '全局AI白名单为空';
    
    await e.reply(msg);
    return true;
  }

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
      `• 表情包：${emotionStats}`,
      `• 工作流：${this.chatStream ? '已加载' : '未加载'}`
    ];
    
    await e.reply(status.join('\n'));
    return true;
  }

  async clearExpiredTasks(e) {
    try {
      const tasks = await this.loadTasks();
      const now = Date.now();
      let cleared = 0;
      
      for (const [id, task] of Object.entries(tasks)) {
        if (new Date(task.time) < now) {
          delete tasks[id];
          
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

  scheduleTask(task) {
    try {
      if (scheduledTasks.has(task.id)) {
        const existingJob = scheduledTasks.get(task.id);
        existingJob.cancel();
        scheduledTasks.delete(task.id);
      }
      
      const taskTime = new Date(task.time);
      
      const job = schedule.scheduleJob(taskTime, async () => {
        try {
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
          
          const tasks = await this.loadTasks();
          delete tasks[task.id];
          await Bot.writeFile(TASKS_PATH, YAML.stringify(tasks));
          
          scheduledTasks.delete(task.id);
          
          logger.info(`[XRK-AI] 任务${task.id}执行完成并已删除`);
        } catch (err) {
          logger.error(`[XRK-AI] 任务执行失败: ${err.message}`);
          scheduledTasks.delete(task.id);
        }
      });
      
      scheduledTasks.set(task.id, job);
      logger.info(`[XRK-AI] 任务${task.id}已调度`);
    } catch (error) {
      logger.error(`[XRK-AI] 调度任务失败: ${error.message}`);
    }
  }

  cleanupCache() {
    const now = Date.now();
    
    for (const [groupId, messages] of messageHistory.entries()) {
      const filtered = messages.filter(msg => now - msg.time < 1800000);
      if (filtered.length === 0) {
        messageHistory.delete(groupId);
      } else {
        messageHistory.set(groupId, filtered);
      }
    }
    
    for (const [key, data] of userCache.entries()) {
      if (now - data.time > 300000) {
        userCache.delete(key);
      }
    }
    
    for (const [groupId, state] of globalAIState.entries()) {
      if (now - state.lastMessageTime > 3600000) {
        globalAIState.delete(groupId);
      }
    }
    
    logger.debug(`[XRK-AI] 缓存清理完成`);
  }

  buildSystemPrompt(e, persona, dateStr, isGlobalTrigger) {
    const botRole = this.getBotRole(e);
    
    return `【人设设定】
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
5. 适当使用表情包和互动功能`;
  }
}