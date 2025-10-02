import path from 'path';
import YAML from 'yaml';
import schedule from 'node-schedule';
import StreamLoader from '../../../lib/aistream/loader.js';
import { 解析向日葵插件yaml, 保存yaml } from '../components/config.js';

const _path = process.cwd();

// 全局存储
const scheduledTasks = new Map();
const globalAIState = new Map();
const groupPersonas = new Map();
const messageHistory = new Map();
const userCache = new Map();
const TASKS_PATH = path.join(_path, 'data/xrk-ai-tasks.yaml');

// 配置
let config = null;

// 工具函数
function randomRange(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export class XRKAIAssistant extends plugin {
  constructor() {
    super({
      name: 'XRK-AI助手',
      dsc: '智能AI助手（工作流版本）',
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
    // 等待工作流系统初始化
    await StreamLoader.load();
    
    this.chatStream = null;
    this.cleanupStream = null;
    // 获取聊天工作流
    this.chatStream = StreamLoader.getStream('chat');
    this.cleanupStream = StreamLoader.getStream('cleanup');
    
    if (!this.chatStream) {
      logger.error('[XRK-AI] 聊天工作流未找到');
    }
    
    // 根据配置启用/禁用功能
    if (this.chatStream) {
      const featureConfig = config.ai?.features || {};
      
      for (const [feature, enabled] of Object.entries(featureConfig)) {
        this.chatStream.setFeatureEnabled(feature, enabled);
      }
    }
    
    // 加载定时任务
    await this.loadScheduledTasks();
    
    // 定期清理缓存
    setInterval(() => this.cleanupCache(), 300000); // 5分钟
    
    logger.info('[XRK-AI] AI助手（工作流版本）初始化完成');
  }

  /** 主消息处理器 */
  async handleMessage(e) {
    try {
      // 记录消息历史
      this.recordMessageHistory(e);
      
      // 管理命令
      if (e.isMaster) {
        if (e.msg?.startsWith('#AI')) {
          return await this.handleAdminCommands(e);
        }
        
        // 清理命令使用清理工作流
        if (e.msg?.startsWith('#清理')) {
          return await this.handleCleanupCommand(e);
        }
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
    // 检查是否在白名单中
    const isInWhitelist = () => {
      if (e.isGroup) {
        const groupWhitelist = (config.ai?.whitelist?.groups || []).map(id => Number(id));
        return groupWhitelist.includes(Number(e.group_id));
      } else {
        const userWhitelist = (config.ai?.whitelist?.users || []).map(id => Number(id));
        return userWhitelist.includes(Number(e.user_id));
      }
    };
    
    // 1. 被@时触发
    if (e.atBot) {
      return isInWhitelist();
    }
    
    // 2. 前缀触发
    const triggerPrefix = config.ai?.triggerPrefix;
    if (triggerPrefix !== undefined && triggerPrefix !== null && triggerPrefix !== '') {
      if (e.msg?.startsWith(triggerPrefix)) {
        return isInWhitelist();
      }
    }
    
    // 3. 全局AI触发
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
    
    // 重置计数
    if (now - state.lastMessageTime > 60000) {
      state.messageCount = 1;
      state.activeUsers.clear();
      state.activeUsers.add(e.user_id);
    } else {
      state.messageCount++;
      state.activeUsers.add(e.user_id);
    }
    state.lastMessageTime = now;
    
    // 触发条件
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

  /** 处理AI */
  async processAI(e) {
    if (!this.chatStream) {
      logger.error('[XRK-AI] 聊天工作流未加载');
      return false;
    }
    
    try {
      const groupId = e.group_id || `private_${e.user_id}`;
      
      // 判断是否为全局触发
      const isGlobalTrigger = !e.atBot && 
        (config.ai?.triggerPrefix === undefined || 
         config.ai?.triggerPrefix === null || 
         config.ai?.triggerPrefix === '' || 
         !e.msg?.startsWith(config.ai.triggerPrefix));
      
      // 处理消息内容
      let question = await this.processMessageContent(e);
      
      // 如果是主动触发但没有内容
      if (!isGlobalTrigger && !question && !e.img?.length) {
        await this.chatStream.sendResponse({ e }, {
          text: ['有什么需要帮助的吗？'],
          emotions: ['惊讶'],
          functions: [],
          segments: ['[惊讶]有什么需要帮助的吗？']
        });
        return true;
      }
      
      // 获取历史消息
      const history = messageHistory.get(e.group_id) || [];
      const relevantHistory = isGlobalTrigger ? 
        history.slice(-15) : 
        history.slice(-(config.ai?.historyLimit || 10));
      
      // 设置当前人设
      const personaName = groupPersonas.get(groupId) || 
                         config.ai?.defaultPersona || 'assistant';
      this.chatStream.currentPersona = personaName;
      
      // 构建上下文
      const context = {
        e,
        question,
        history: relevantHistory,
        isGlobalTrigger,
        groupId
      };
      
      // 工作流配置
      const streamConfig = {
        config: {
          ai: {
            baseUrl: config.ai?.baseUrl,
            apiKey: config.ai?.apiKey,
            model: config.ai?.chatModel || 'gpt-3.5-turbo',
            temperature: config.ai?.temperature || 0.8,
            maxTokens: config.ai?.max_tokens || 6000,
            top_p: config.ai?.top_p || 0.9,
            presence_penalty: config.ai?.presence_penalty || 0.6,
            frequency_penalty: config.ai?.frequency_penalty || 0.6
          }
        }
      };
      
      // 执行工作流
      const result = await this.chatStream.process(context, streamConfig);
      
      if (!result.success) {
        // 全局触发失败时静默处理
        if (isGlobalTrigger) {
          logger.debug('[XRK-AI] 全局AI响应失败，静默处理');
          return false;
        }
        return true;
      }
      
      return true;
    } catch (error) {
      logger.error(`[XRK-AI] AI处理失败: ${error.message}`);
      return false;
    }
  }

  /** 处理消息内容 */
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
            // 使用视觉模型处理图片
            if (config.ai?.visionModel) {
              const desc = await this.processImageWithVision(seg.url || seg.file);
              content += `[图片:${desc}] `;
            } else {
              content += '[图片] ';
            }
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

  /** 使用视觉模型处理图片 */
  async processImageWithVision(imageUrl) {
    // 这里简化处理，实际应该调用视觉API
    return '一张图片';
  }

  /** 处理清理命令 */
  async handleCleanupCommand(e) {
    if (!this.cleanupStream) {
      await e.reply('清理工作流未加载');
      return true;
    }
    
    const context = {
      e,
      question: e.msg.replace('#清理', '').trim() || '请帮我清理系统垃圾'
    };
    
    const streamConfig = {
      config: {
        ai: {
          baseUrl: config.ai?.baseUrl,
          apiKey: config.ai?.apiKey,
          model: config.ai?.chatModel || 'gpt-3.5-turbo',
          temperature: 0.5,
          maxTokens: 1000
        }
      }
    };
    
    await this.cleanupStream.process(context, streamConfig);
    return true;
  }

  /** 管理命令处理 */
  async handleAdminCommands(e) {
    const msg = e.msg;
    
    if (msg === '#AI帮助') {
      return await this.showHelp(e);
    }
    else if (msg === '#AI状态') {
      return await this.showStatus(e);
    }
    else if (/^#AI切换人设\s*(.+)$/.test(msg)) {
      const persona = msg.match(/^#AI切换人设\s*(.+)$/)[1];
      return await this.switchPersona(e, persona);
    }
    else if (msg === '#AI当前人设') {
      return await this.showCurrentPersona(e);
    }
    else if (msg === '#AI功能列表') {
      return await this.showFeatures(e);
    }
    else if (/^#AI(启用|禁用)功能\s*(.+)$/.test(msg)) {
      const [, action, feature] = msg.match(/^#AI(启用|禁用)功能\s*(.+)$/);
      return await this.toggleFeature(e, feature, action === '启用');
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
    else if (msg === '#AI重载') {
      await StreamLoader.reload();
      this.chatStream = StreamLoader.getStream('chat');
      this.cleanupStream = StreamLoader.getStream('cleanup');
      await e.reply('工作流系统已重载');
      return true;
    }
    else if (msg === '#AI工作流') {
      return await this.showStreams(e);
    }
    
    return false;
  }

  /** 显示帮助 */
  async showHelp(e) {
    const help = `【AI助手管理命令】
#AI帮助 - 显示此帮助
#AI状态 - 查看运行状态
#AI切换人设 <人设名> - 切换人设
#AI当前人设 - 查看当前人设
#AI功能列表 - 查看所有功能
#AI启用功能 <功能名> - 启用功能
#AI禁用功能 <功能名> - 禁用功能
#AI添加全局 [群号] - 添加全局AI
#AI移除全局 [群号] - 移除全局AI
#AI查看全局 - 查看全局AI列表
#AI重载 - 重载工作流系统
#AI工作流 - 查看已加载的工作流

【清理命令】
#清理 - 执行系统清理
#清理缓存 - 清理缓存文件
#清理日志 - 清理过期日志

【功能说明】
• 工作流系统：模块化的AI功能管理
• 支持动态启用/禁用功能
• 触发概率：${(config.ai?.globalAIChance || 0.05) * 100}%
• 冷却时间：${config.ai?.globalAICooldown || 300}秒`;
    
    await e.reply(help);
    return true;
  }

  /** 显示状态 */
  async showStatus(e) {
    const chatInfo = this.chatStream ? this.chatStream.getInfo() : null;
    const cleanupInfo = this.cleanupStream ? this.cleanupStream.getInfo() : null;
    
    const status = [
      `【AI助手运行状态】`,
      `• 工作流系统：${StreamLoader.getAllStreams().length}个工作流`,
      `• 消息缓存：${messageHistory.size}个群`,
      `• 用户缓存：${userCache.size}条`,
      `• 定时任务：${scheduledTasks.size}个`,
      `• 普通白名单群：${(config.ai?.whitelist?.groups || []).length}个`,
      `• 全局AI群：${(config.ai?.globalWhitelist || []).length}个`,
      `• 触发前缀：${config.ai?.triggerPrefix || '无'}`,
      `• 触发概率：${(config.ai?.globalAIChance || 0.05) * 100}%`,
      `• 冷却时间：${config.ai?.globalAICooldown || 300}秒`,
      '',
      `【已加载工作流】`
    ];
    
    if (chatInfo) {
      status.push(`• 聊天工作流 v${chatInfo.version} - ${chatInfo.features.filter(f => f.enabled).length}/${chatInfo.features.length}个功能启用`);
    }
    
    if (cleanupInfo) {
      status.push(`• 清理工作流 v${cleanupInfo.version} - ${cleanupInfo.features.filter(f => f.enabled).length}/${cleanupInfo.features.length}个功能启用`);
    }
    
    await e.reply(status.join('\n'));
    return true;
  }

  /** 显示功能列表 */
  async showFeatures(e) {
    if (!this.chatStream) {
      await e.reply('聊天工作流未加载');
      return true;
    }
    
    const info = this.chatStream.getInfo();
    const features = info.features.map(f => 
      `• ${f.name}${f.description ? `(${f.description})` : ''} - ${f.enabled ? '✓启用' : '✗禁用'}`
    );
    
    await e.reply(`【聊天工作流功能】\n${features.join('\n')}`);
    return true;
  }

  /** 切换功能 */
  async toggleFeature(e, featureName, enabled) {
    if (!this.chatStream) {
      await e.reply('聊天工作流未加载');
      return true;
    }
    
    this.chatStream.setFeatureEnabled(featureName, enabled);
    
    // 保存到配置
    const cfg = 解析向日葵插件yaml();
    if (!cfg.ai) cfg.ai = {};
    if (!cfg.ai.features) cfg.ai.features = {};
    cfg.ai.features[featureName] = enabled;
    await 保存yaml(path.join(_path, 'data/xrkconfig/config.yaml'), cfg);
    config = cfg;
    
    await e.reply(`已${enabled ? '启用' : '禁用'}功能：${featureName}`);
    return true;
  }

  /** 切换人设 */
  async switchPersona(e, personaName) {
    if (!this.chatStream) {
      await e.reply('聊天工作流未加载');
      return true;
    }
    
    const personas = this.chatStream.personas;
    if (!personas[personaName]) {
      await e.reply(`未找到人设"${personaName}"\n可用：${Object.keys(personas).join('、')}`);
      return true;
    }
    
    const groupId = e.group_id || `private_${e.user_id}`;
    groupPersonas.set(groupId, personaName);
    
    await e.reply(`已切换到人设"${personaName}"`);
    return true;
  }

  /** 显示当前人设 */
  async showCurrentPersona(e) {
    const groupId = e.group_id || `private_${e.user_id}`;
    const personaName = groupPersonas.get(groupId) || 
                       config.ai?.defaultPersona || 'assistant';
    
    if (this.chatStream && this.chatStream.personas[personaName]) {
      const content = this.chatStream.personas[personaName];
      await e.reply(`当前人设：${personaName}\n\n${content.substring(0, 100)}...`);
    } else {
      await e.reply(`当前人设：${personaName}（未找到人设文件）`);
    }
    return true;
  }

  /** 显示工作流列表 */
  async showStreams(e) {
    const streams = StreamLoader.getAllStreams();
    const list = streams.map(stream => {
      const info = stream.getInfo();
      return `【${info.name}】v${info.version}\n${info.description}\n功能数：${info.features.length}`;
    });
    
    await e.reply(`已加载工作流：\n\n${list.join('\n\n')}`);
    return true;
  }

  /** 添加全局AI白名单 */
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
      await e.reply(`已添加群${gid}到全局AI白名单`);
    } else {
      await e.reply(`群${gid}已在白名单中`);
    }
    return true;
  }

  /** 移除全局AI白名单 */
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

  /** 调度任务 */
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
          
          scheduledTasks.delete(task.id);
          logger.info(`[XRK-AI] 任务${task.id}执行完成`);
        } catch (err) {
          logger.error(`[XRK-AI] 任务执行失败: ${err.message}`);
          scheduledTasks.delete(task.id);
        }
      });
      
      scheduledTasks.set(task.id, job);
    } catch (error) {
      logger.error(`[XRK-AI] 调度任务失败: ${error.message}`);
    }
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
      if (now - data.time > 300000) {
        userCache.delete(key);
      }
    }
    
    // 清理全局AI状态
    for (const [groupId, state] of globalAIState.entries()) {
      if (now - state.lastMessageTime > 3600000) {
        globalAIState.delete(groupId);
      }
    }
    
    logger.debug(`[XRK-AI] 缓存清理完成`);
  }
}