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
const PERSONAS_DIR = path.join(_path, 'plugins/XRK/config/ai-assistant/personas');
const TASKS_PATH = path.join(_path, 'data/xrk-ai-tasks.yaml');
const TEMP_IMAGE_DIR = path.join(_path, 'data/temp/ai_images');

let config = null;
let personas = {};
const messageHistory = new Map();
const groupPersonas = new Map();
const globalAIState = new Map();
const scheduledTasks = new Map();
const userCache = new Map();

export class XRKAIAssistant extends plugin {
  constructor() {
    super({
      name: 'XRK-AI助手',
      dsc: '智能AI助手',
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
    await this.createDirs();
    await this.createDefaultPersona();
    personas = await this.loadPersonas();
    await this.loadScheduledTasks();
    
    setInterval(() => this.cleanupCache(), 300000);
    
    logger.info('[XRK-AI] 初始化完成');
  }

  async createDirs() {
    const dirs = [PERSONAS_DIR, TEMP_IMAGE_DIR];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  async createDefaultPersona() {
    const defaultPath = path.join(PERSONAS_DIR, 'assistant.txt');
    if (!fs.existsSync(defaultPath)) {
      await fs.promises.writeFile(defaultPath, 
`我是${Bot.nickname}，一个智能AI助手。
我会认真观察群聊，适时发表评论和互动。
喜欢用表情回应别人的消息，也会戳一戳活跃气氛。
对不同的人有不同的态度，记得每个人的名字。
会根据聊天氛围选择合适的表情和互动方式。`);
    }
  }

  async handleMessage(e) {
    try {
      this.recordMessage(e);
      
      if (e.isMaster && e.msg?.startsWith('#AI')) {
        return await this.handleAdminCommands(e);
      }

      if (await this.shouldTriggerAI(e)) {
        return await this.processAI(e);
      }
    } catch (error) {
      logger.error(`[XRK-AI] 处理失败: ${error.message}`);
    }
    
    return false;
  }

  recordMessage(e) {
    if (!e.isGroup) return;
    
    const groupId = e.group_id;
    if (!messageHistory.has(groupId)) {
      messageHistory.set(groupId, []);
    }
    
    const history = messageHistory.get(groupId);
    history.push({
      user_id: e.user_id,
      nickname: e.sender?.card || e.sender?.nickname || '未知',
      message: e.raw_message || e.msg,
      message_id: e.message_id,
      time: Date.now()
    });
    
    if (history.length > 30) history.shift();
  }

  async shouldTriggerAI(e) {
    const isInWhitelist = () => {
      if (e.isGroup) {
        const groups = (config.ai?.whitelist?.groups || []).map(Number);
        return groups.includes(Number(e.group_id));
      } else {
        const users = (config.ai?.whitelist?.users || []).map(Number);
        return users.includes(Number(e.user_id));
      }
    };
    
    if (e.atBot) return isInWhitelist();
    
    const prefix = config.ai?.triggerPrefix;
    if (prefix && e.msg?.startsWith(prefix)) {
      return isInWhitelist();
    }
    
    if (!e.isGroup) return false;
    
    const globalList = (config.ai?.globalWhitelist || []).map(Number);
    if (!globalList.includes(Number(e.group_id))) return false;
    
    const state = globalAIState.get(e.group_id) || { 
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
      globalAIState.set(e.group_id, state);
      return true;
    }
    
    globalAIState.set(e.group_id, state);
    return false;
  }

  async processAI(e) {
    const stream = this.getStream('chat');
    if (!stream) {
      logger.error('[XRK-AI] 工作流未加载');
      return false;
    }
    
    const isGlobalTrigger = !e.atBot && !e.msg?.startsWith(config.ai?.triggerPrefix || '');
    
    let question = await this.processContent(e);
    
    if (!isGlobalTrigger && !question && !e.img?.length) {
      const img = stream.getRandomEmotionImage('惊讶');
      if (img) await e.reply(segment.image(img));
      await e.reply('有什么需要帮助的吗？');
      return true;
    }
    
    const groupId = e.group_id || `private_${e.user_id}`;
    const history = e.isGroup ? (messageHistory.get(e.group_id) || []) : [];
    const validQQs = history.map(m => String(m.user_id));
    
    const result = await stream.process(e, {
      text: question,
      persona: this.getCurrentPersona(groupId),
      isGlobalTrigger,
      history,
      validQQs,
      reminderCallback: async (task) => {
        await this.saveTask(task);
        this.scheduleTask(task);
      }
    }, {
      baseUrl: config.ai?.baseUrl,
      apiKey: config.ai?.apiKey,
      model: config.ai?.chatModel
    });
    
    if (!result) {
      if (isGlobalTrigger) return false;
      return true;
    }

    await this.processResponse(e, result, stream, validQQs);
    return true;
  }

  async processContent(e) {
    let content = '';
    const message = e.message;
    
    if (!Array.isArray(message)) {
      return e.msg || '';
    }
    
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
    
    if (config.ai?.triggerPrefix) {
      content = content.replace(new RegExp(`^${config.ai.triggerPrefix}`), '');
    }
    
    return content.trim();
  }

  async processImage(url) {
    if (!url || !config.ai?.visionModel) return '无法识别';
    
    let tempPath = null;
    try {
      tempPath = await this.downloadImage(url);
      const uploadedUrl = await this.uploadImage(tempPath);
      
      const messages = [
        {
          role: 'system',
          content: '详细描述图片内容'
        },
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: uploadedUrl } }]
        }
      ];
      
      const result = await this.callAI(messages, config.ai.visionModel);
      return result || '识图失败';
    } catch (err) {
      logger.debug(`[XRK-AI] 识图失败: ${err.message}`);
      return '图片处理失败';
    } finally {
      if (tempPath && fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
    }
  }

  async downloadImage(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('下载失败');
    
    const filename = `temp_${Date.now()}.png`;
    const filePath = path.join(TEMP_IMAGE_DIR, filename);
    
    await promisify(pipeline)(response.body, fs.createWriteStream(filePath));
    return filePath;
  }

  async uploadImage(filePath) {
    if (!config.ai?.fileUploadUrl) throw new Error('未配置上传URL');
    
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
    
    if (!response.ok) throw new Error('上传失败');
    
    const result = await response.json();
    return result.data?.url || result.url;
  }

  async processResponse(e, result, stream, validQQs) {
    let emotionSent = false;
    
    for (let i = 0; i < result.segments.length; i++) {
      const seg = result.segments[i];
      
      if (!emotionSent) {
        const emotionFunc = seg.functions.find(f => f.type === 'emotion');
        if (emotionFunc) {
          await stream.executeFunction(emotionFunc, { e, stream });
          emotionSent = true;
        }
      }
      
      if (seg.textParts.length > 0) {
        const msgSegs = [];
        for (const part of seg.textParts) {
          const cqSegs = await stream.parseCQCodes(part, e, validQQs);
          msgSegs.push(...cqSegs);
        }
        
        if (msgSegs.length > 0) {
          await e.reply(msgSegs, Math.random() > 0.5);
        }
      }
      
      for (const func of seg.functions) {
        if (func.type !== 'emotion') {
          await stream.executeFunction(func, { 
            e, 
            stream,
            reminderCallback: async (task) => {
              await this.saveTask(task);
              this.scheduleTask(task);
            }
          });
        }
      }
      
      if (i < result.segments.length - 1) {
        await new Promise(resolve => setTimeout(resolve, Math.random() * 700 + 800));
      }
    }
  }

  async callAI(messages, model) {
    try {
      const response = await fetch(`${config.ai?.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.ai?.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: model || config.ai?.chatModel,
          messages,
          temperature: config.ai?.temperature || 0.8,
          max_tokens: config.ai?.max_tokens || 6000,
          top_p: config.ai?.top_p || 0.9,
          presence_penalty: config.ai?.presence_penalty || 0.6,
          frequency_penalty: config.ai?.frequency_penalty || 0.6
        }),
        timeout: 30000
      });

      if (!response.ok) throw new Error(`API错误: ${response.status}`);

      const result = await response.json();
      return result.choices?.[0]?.message?.content || null;
    } catch (err) {
      logger.error(`[XRK-AI] API失败: ${err.message}`);
      return null;
    }
  }

  async handleAdminCommands(e) {
    const msg = e.msg;
    
    if (msg === '#AI帮助') return await this.showHelp(e);
    if (/^#AI切换人设\s*(.+)$/.test(msg)) {
      const persona = msg.match(/^#AI切换人设\s*(.+)$/)[1];
      return await this.switchPersona(e, persona);
    }
    if (msg === '#AI当前人设') return await this.showCurrentPersona(e);
    if (msg === '#AI人设列表') return await this.listPersonas(e);
    if (/^#AI添加全局\s*(\d+)?$/.test(msg)) {
      const gid = msg.match(/(\d+)$/)?.[1] || e.group_id;
      return await this.addGlobalWhitelist(e, gid);
    }
    if (/^#AI移除全局\s*(\d+)?$/.test(msg)) {
      const gid = msg.match(/(\d+)$/)?.[1] || e.group_id;
      return await this.removeGlobalWhitelist(e, gid);
    }
    if (msg === '#AI查看全局') return await this.showGlobalWhitelist(e);
    if (msg === '#AI重载') {
      personas = await this.loadPersonas();
      const stream = this.getStream('chat');
      if (stream) await stream.loadEmotionImages();
      await e.reply('已重载');
      return true;
    }
    if (msg === '#AI清理任务') return await this.clearExpiredTasks(e);
    if (msg === '#AI状态') return await this.showStatus(e);
    
    return false;
  }

  async loadPersonas() {
    const map = {};
    try {
      const files = await fs.promises.readdir(PERSONAS_DIR);
      for (const file of files) {
        if (file.endsWith('.txt')) {
          const name = path.basename(file, '.txt');
          map[name] = await fs.promises.readFile(path.join(PERSONAS_DIR, file), 'utf8');
        }
      }
    } catch (err) {
      logger.error(`[XRK-AI] 加载人设失败: ${err.message}`);
    }
    return map;
  }

  getCurrentPersona(groupId) {
    const name = groupPersonas.get(groupId) || config.ai?.defaultPersona || 'assistant';
    return personas[name] || personas.assistant || '我是AI助手';
  }

  async switchPersona(e, name) {
    if (!personas[name]) {
      await e.reply(`未找到人设"${name}"\n可用：${Object.keys(personas).join('、')}`);
      return true;
    }
    
    const gid = e.group_id || `private_${e.user_id}`;
    groupPersonas.set(gid, name);
    await e.reply(`已切换到"${name}"`);
    return true;
  }

  async showCurrentPersona(e) {
    const gid = e.group_id || `private_${e.user_id}`;
    const name = groupPersonas.get(gid) || 'assistant';
    const content = personas[name];
    await e.reply(`当前人设：${name}\n\n${content.substring(0, 100)}...`);
    return true;
  }

  async listPersonas(e) {
    const list = Object.keys(personas).map(n => 
      `【${n}】\n${personas[n].substring(0, 50)}...`
    ).join('\n\n');
    await e.reply(`人设列表：\n\n${list}`);
    return true;
  }

  async addGlobalWhitelist(e, gid) {
    if (!gid || gid === 'undefined') {
      await e.reply('请指定群号');
      return true;
    }
    
    const cfg = 解析向日葵插件yaml();
    if (!cfg.ai) cfg.ai = {};
    if (!cfg.ai.globalWhitelist) cfg.ai.globalWhitelist = [];
    
    const id = Number(gid);
    if (!cfg.ai.globalWhitelist.includes(id)) {
      cfg.ai.globalWhitelist.push(id);
      await 保存yaml(path.join(_path, 'data/xrkconfig/config.yaml'), cfg);
      config = cfg;
      await e.reply(`已添加${id}`);
    } else {
      await e.reply(`${id}已存在`);
    }
    return true;
  }

  async removeGlobalWhitelist(e, gid) {
    if (!gid || gid === 'undefined') {
      await e.reply('请指定群号');
      return true;
    }
    
    const cfg = 解析向日葵插件yaml();
    if (cfg.ai?.globalWhitelist) {
      const id = Number(gid);
      cfg.ai.globalWhitelist = cfg.ai.globalWhitelist.filter(g => g !== id);
      await 保存yaml(path.join(_path, 'data/xrkconfig/config.yaml'), cfg);
      config = cfg;
      await e.reply(`已移除${id}`);
    }
    return true;
  }

  async showGlobalWhitelist(e) {
    const list = config.ai?.globalWhitelist || [];
    await e.reply(list.length ? `全局AI：\n${list.join('\n')}` : '全局AI为空');
    return true;
  }

  async showHelp(e) {
    await e.reply(`【AI助手】
#AI帮助
#AI切换人设 <名称>
#AI当前人设
#AI人设列表
#AI添加全局 [群号]
#AI移除全局 [群号]
#AI查看全局
#AI重载
#AI清理任务
#AI状态`);
    return true;
  }

  async showStatus(e) {
    const stream = this.getStream('chat');
    let emotionStats = '';
    if (stream) {
      emotionStats = Object.entries(stream.emotionImages)
        .map(([e, imgs]) => `${e}:${imgs.length}`)
        .join(' ');
    }
    
    await e.reply(`【状态】
工作流：${stream ? '✓' : '✗'}
人设：${Object.keys(personas).length}个
白名单：${(config.ai?.whitelist?.groups || []).length}个
全局AI：${(config.ai?.globalWhitelist || []).length}个
前缀：${config.ai?.triggerPrefix || '无'}
概率：${(config.ai?.globalAIChance || 0.05) * 100}%
冷却：${config.ai?.globalAICooldown || 300}秒
表情包：${emotionStats}`);
    return true;
  }

  async saveTask(task) {
    const tasks = await this.loadTasks();
    tasks[task.id] = task;
    await fs.promises.writeFile(TASKS_PATH, YAML.stringify(tasks));
  }

  async loadTasks() {
    try {
      if (!fs.existsSync(TASKS_PATH)) {
        await fs.promises.writeFile(TASKS_PATH, YAML.stringify({}));
        return {};
      }
      const content = await fs.promises.readFile(TASKS_PATH, 'utf8');
      return YAML.parse(content) || {};
    } catch {
      return {};
    }
  }

  async loadScheduledTasks() {
    const tasks = await this.loadTasks();
    const now = new Date();
    
    Object.values(tasks).forEach(task => {
      if (new Date(task.time) > now) {
        this.scheduleTask(task);
      }
    });
  }

  scheduleTask(task) {
    if (scheduledTasks.has(task.id)) {
      scheduledTasks.get(task.id).cancel();
      scheduledTasks.delete(task.id);
    }
    
    const job = schedule.scheduleJob(new Date(task.time), async () => {
      try {
        const msg = `【提醒】${task.content}`;
        if (task.group) {
          await Bot.sendGroupMsg(task.group, msg);
        } else if (task.private) {
          await Bot.sendPrivateMsg(task.private, msg);
        }
        
        const tasks = await this.loadTasks();
        delete tasks[task.id];
        await fs.promises.writeFile(TASKS_PATH, YAML.stringify(tasks));
        scheduledTasks.delete(task.id);
      } catch (err) {
        logger.error(`[XRK-AI] 任务执行失败: ${err.message}`);
        scheduledTasks.delete(task.id);
      }
    });
    
    scheduledTasks.set(task.id, job);
  }

  async clearExpiredTasks(e) {
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
    
    await fs.promises.writeFile(TASKS_PATH, YAML.stringify(tasks));
    await e.reply(`已清理${cleared}个任务`);
    return true;
  }

  cleanupCache() {
    const now = Date.now();
    
    for (const [gid, msgs] of messageHistory.entries()) {
      const filtered = msgs.filter(m => now - m.time < 1800000);
      if (filtered.length === 0) {
        messageHistory.delete(gid);
      } else {
        messageHistory.set(gid, filtered);
      }
    }
    
    for (const [key, data] of userCache.entries()) {
      if (now - data.time > 300000) {
        userCache.delete(key);
      }
    }
    
    for (const [gid, state] of globalAIState.entries()) {
      if (now - state.lastMessageTime > 3600000) {
        globalAIState.delete(gid);
      }
    }
  }
}