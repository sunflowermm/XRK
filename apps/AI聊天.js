import path from 'path';
import YAML from 'yaml';
import schedule from 'node-schedule';
import BotUtil from '../../../lib/common/util.js';
import { 解析向日葵插件yaml, 保存yaml } from '../components/config.js';

const _path = process.cwd();
const PERSONAS_DIR = path.join(_path, 'plugins/XRK/config/ai-assistant/personas');
const TASKS_PATH = path.join(_path, 'data/xrk-ai-tasks.yaml');

// 全局存储
const globalAIState = new Map();
const groupPersonas = new Map();
const scheduledTasks = new Map();

// 配置和人设
let config = null;
let personas = {};

// 工具函数
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

  async init() {
    // 创建目录
    await BotUtil.mkdir(PERSONAS_DIR);
    
    // 创建默认人设
    const defaultPersonaPath = path.join(PERSONAS_DIR, 'assistant.txt');
    if (!await BotUtil.fileExists(defaultPersonaPath)) {
      await BotUtil.writeFile(defaultPersonaPath, `我是${Bot.nickname}，一个智能AI助手。
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
    
    logger.info('[XRK-AI] AI助手初始化完成');
  }

  async handleMessage(e) {
    try {
      // 获取聊天工作流并记录消息
      const chatStream = this.getStream('chat');
      if (chatStream) {
        chatStream.recordMessage(e);
      }
      
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

  async loadPersonas() {
    const personasMap = {};
    try {
      const files = await BotUtil.glob(path.join(PERSONAS_DIR, '*.txt'));
      for (const file of files) {
        const name = path.basename(file, '.txt');
        personasMap[name] = await BotUtil.readFile(file, 'utf8');
      }
    } catch (error) {
      logger.error(`[XRK-AI] 加载人设失败: ${error.message}`);
    }
    return personasMap;
  }

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

  async processAI(e) {
    try {
      const chatStream = this.getStream('chat');
      if (!chatStream) {
        logger.error('[XRK-AI] 聊天工作流未加载');
        return false;
      }
      
      // 判断是否为全局触发
      const isGlobalTrigger = !e.atBot && 
        (config.ai?.triggerPrefix === undefined || 
         config.ai?.triggerPrefix === null || 
         config.ai?.triggerPrefix === '' || 
         !e.msg?.startsWith(config.ai.triggerPrefix));
      
      // 处理消息内容（包含识图）
      let question = await this.processMessageContent(e, chatStream);
      
      // 如果主动触发但没有内容
      if (!isGlobalTrigger && !question.content && !question.imageDescriptions?.length) {
        const emotionImage = chatStream.getRandomEmotionImage('惊讶');
        if (emotionImage) {
          await e.reply(segment.image(emotionImage));
          await BotUtil.sleep(300);
        }
        await e.reply('有什么需要帮助的吗？');
        return true;
      }
      
      // 准备工作流参数
      const groupId = e.group_id || `private_${e.user_id}`;
      const persona = this.getCurrentPersona(groupId);
      
      // 构建question对象
      const questionObj = {
        ...question,
        persona,
        isGlobalTrigger
      };
      
      // API配置
      const apiConfig = {
        baseUrl: config.ai?.baseUrl,
        apiKey: config.ai?.apiKey,
        model: config.ai?.chatModel,
        temperature: config.ai?.temperature,
        maxTokens: config.ai?.max_tokens,
        topP: config.ai?.top_p,
        presencePenalty: config.ai?.presence_penalty,
        frequencyPenalty: config.ai?.frequency_penalty,
        visionModel: config.ai?.visionModel,
        fileUploadUrl: config.ai?.fileUploadUrl,
        timeout: 30000
      };
      
      // 调用工作流处理
      const result = await chatStream.process(e, questionObj, apiConfig);
      
      if (!result) {
        // 全局触发失败时静默处理
        if (isGlobalTrigger) {
          return false;
        }
        await e.reply('处理失败，请稍后重试');
        return true;
      }

      // 处理工作流响应
      await this.processStreamResponse(e, result, chatStream);
      return true;
    } catch (error) {
      logger.error(`[XRK-AI] AI处理失败: ${error.message}`);
      return false;
    }
  }

  async processMessageContent(e, chatStream) {
    let content = '';
    const imageDescriptions = [];
    const message = e.message;
    
    if (!Array.isArray(message)) {
      return { content: e.msg || '', text: e.msg || '' };
    }
    
    try {
      // 处理回复
      if (e.source && e.getReply) {
        try {
          const reply = await e.getReply();
          if (reply) {
            const nickname = reply.sender?.card || reply.sender?.nickname || '未知';
            content += `[回复${nickname}的"${reply.raw_message?.substring(0, 30) || ''}..."] `;
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
            // 识图处理
            if (config.ai?.visionModel) {
              const desc = await chatStream.processImage(seg.url || seg.file, {
                apiKey: config.ai?.apiKey,
                baseUrl: config.ai?.baseUrl,
                visionModel: config.ai?.visionModel,
                fileUploadUrl: config.ai?.fileUploadUrl
              });
              imageDescriptions.push(`[图片:${desc}]`);
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
      
      return { 
        content: content.trim(),
        text: content.trim(),
        imageDescriptions
      };
    } catch (error) {
      logger.error(`[XRK-AI] 处理消息内容失败: ${error.message}`);
      return { content: e.msg || '', text: e.msg || '' };
    }
  }

  async processStreamResponse(e, result, stream) {
    try {
      let emotionSent = false;
      
      for (let i = 0; i < result.segments.length; i++) {
        const segment = result.segments[i];
        
        // 发送表情包（只发第一个）
        if (!emotionSent) {
          const emotionFunc = segment.functions.find(f => f.type === 'emotion');
          if (emotionFunc) {
            await stream.executeFunction(emotionFunc, { e, stream });
            emotionSent = true;
            await BotUtil.sleep(300);
          }
        }
        
        // 发送文本消息（cleanText已经删除了功能标记）
        if (segment.text) {
          const msgSegments = await stream.parseCQCodes(segment.text, e);
          if (msgSegments.length > 0) {
            const quote = Math.random() > 0.5 && !e.atBot;
            await e.reply(msgSegments, quote);
          }
        }
        
        // 执行其他功能
        for (const func of segment.functions) {
          if (func.type !== 'emotion') {
            if (func.type === 'reminder') {
              // 特殊处理提醒功能
              await this.createReminder(e, func.params);
            } else {
              await stream.executeFunction(func, { e, stream });
            }
            await BotUtil.sleep(300);
          }
        }
        
        // 延迟到下一段
        if (i < result.segments.length - 1) {
          await BotUtil.sleep(randomRange(800, 1500));
        }
      }
    } catch (error) {
      logger.error(`[XRK-AI] 处理工作流响应失败: ${error.message}`);
    }
  }

  async createReminder(e, params) {
    try {
      const { dateStr, timeStr, content } = params;
      
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
      
      const chatStream = this.getStream('chat');
      const emotionImage = chatStream?.getRandomEmotionImage('开心');
      if (emotionImage) {
        await e.reply(segment.image(emotionImage));
        await BotUtil.sleep(300);
      }
      await e.reply(`已设置提醒：${dateStr} ${timeStr} "${content}"`);
    } catch (error) {
      logger.error(`[XRK-AI] 创建提醒失败: ${error.message}`);
    }
  }

  async saveTask(task) {
    try {
      const tasks = await this.loadTasks();
      tasks[task.id] = task;
      await BotUtil.writeFile(TASKS_PATH, YAML.stringify(tasks));
    } catch (error) {
      logger.error(`[XRK-AI] 保存任务失败: ${error.message}`);
      throw error;
    }
  }

  async loadTasks() {
    try {
      if (!await BotUtil.fileExists(TASKS_PATH)) {
        await BotUtil.writeFile(TASKS_PATH, YAML.stringify({}));
        return {};
      }
      const content = await BotUtil.readFile(TASKS_PATH, 'utf8');
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
          const chatStream = this.getStream('chat');
          const emotionImage = chatStream?.getRandomEmotionImage('开心');
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
          await BotUtil.writeFile(TASKS_PATH, YAML.stringify(tasks));
          
          // 从调度列表中移除
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
      const chatStream = this.getStream('chat');
      if (chatStream) {
        await chatStream.loadEmotionImages();
      }
      await e.reply('人设和表情包已重新加载');
      return true;
    }
    else if (msg === '#AI清理任务') {
      return await this.clearExpiredTasks(e);
    }
    else if (msg === '#AI工作流列表') {
      return await this.listStreams(e);
    }
    else if (/^#AI切换工作流\s*(.+)$/.test(msg)) {
      const streamName = msg.match(/^#AI切换工作流\s*(.+)$/)[1];
      return await this.switchStream(e, streamName);
    }
    else if (msg === '#AI状态') {
      return await this.showStatus(e);
    }
    
    return false;
  }

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
      
      await BotUtil.writeFile(TASKS_PATH, YAML.stringify(tasks));
      
      const chatStream = this.getStream('chat');
      const emotionImage = chatStream?.getRandomEmotionImage('开心');
      if (emotionImage) {
        await e.reply(segment.image(emotionImage));
        await BotUtil.sleep(300);
      }
      await e.reply(`已清理${cleared}个过期任务`);
    } catch (error) {
      logger.error(`[XRK-AI] 清理任务失败: ${error.message}`);
      await e.reply('清理任务失败');
    }
    return true;
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
#AI重载人设 - 重新加载人设和表情包
#AI清理任务 - 清理过期任务
#AI工作流列表 - 查看工作流
#AI切换工作流 <名称> - 切换工作流
#AI状态 - 查看运行状态

【功能说明】
• 触发方式：@机器人、前缀触发
• 全局AI：在白名单群自动参与聊天
• 触发概率：${(config.ai?.globalAIChance || 0.05) * 100}%
• 冷却时间：${config.ai?.globalAICooldown || 300}秒
• 工作流系统：支持多种AI处理模式
• 识图功能：发送图片时自动识别`;
    
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
    
    const chatStream = this.getStream('chat');
    const emotionImage = chatStream?.getRandomEmotionImage('开心');
    if (emotionImage) {
      await e.reply(segment.image(emotionImage));
      await BotUtil.sleep(300);
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
      
      const chatStream = this.getStream('chat');
      const emotionImage = chatStream?.getRandomEmotionImage('开心');
      if (emotionImage) {
        await e.reply(segment.image(emotionImage));
        await BotUtil.sleep(300);
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
      
      const chatStream = this.getStream('chat');
      const emotionImage = chatStream?.getRandomEmotionImage('伤心');
      if (emotionImage) {
        await e.reply(segment.image(emotionImage));
        await BotUtil.sleep(300);
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

  async listStreams(e) {
    const streams = this.getAllStreams();
    if (streams.length === 0) {
      await e.reply('暂无工作流');
      return true;
    }
    
    const list = streams.map(s => {
      const status = s.config.enabled ? '✓' : '✗';
      const funcCount = s.functions?.size || 0;
      return `${status} ${s.name} - ${s.description} (v${s.version}) [${funcCount}个功能]`;
    }).join('\n');
    
    await e.reply(`工作流列表：\n${list}`);
    return true;
  }

  async switchStream(e, streamName) {
    const stream = this.getStream(streamName);
    if (!stream) {
      await e.reply(`未找到工作流"${streamName}"`);
      return true;
    }
    
    const info = stream.getInfo();
    const enabledFuncs = info.functions.filter(f => f.enabled);
    
    let msg = `【${info.name} v${info.version}】\n`;
    msg += `描述：${info.description}\n`;
    msg += `作者：${info.author}\n`;
    msg += `功能数量：${enabledFuncs.length}/${info.functions.length}\n`;
    msg += `状态：${stream.config.enabled ? '✓ 已启用' : '✗ 已禁用'}`;
    
    await e.reply(msg);
    return true;
  }

  async showStatus(e) {
    const chatStream = this.getStream('chat');
    const streams = this.getAllStreams();
    
    const status = [
      `【AI助手运行状态】`,
      `• 工作流数量：${streams.length}个`,
      `• 定时任务：${scheduledTasks.size}个`,
      `• 普通白名单群：${(config.ai?.whitelist?.groups || []).length}个`,
      `• 全局AI群：${(config.ai?.globalWhitelist || []).length}个`,
      `• 触发前缀：${config.ai?.triggerPrefix || '无'}`,
      `• 触发概率：${(config.ai?.globalAIChance || 0.05) * 100}%`,
      `• 冷却时间：${config.ai?.globalAICooldown || 300}秒`,
      `• 人设数量：${Object.keys(personas).length}个`
    ];
    
    if (chatStream) {
      const emotionStats = Object.entries(chatStream.emotionImages)
        .map(([emotion, images]) => `${emotion}:${images.length}张`)
        .join(' ');
      status.push(`• 表情包：${emotionStats}`);
      status.push(`• 消息缓存：${chatStream.messageHistory.size}个群`);
    }
    
    if (config.ai?.visionModel) {
      status.push(`• 识图模型：${config.ai.visionModel}`);
    }
    
    await e.reply(status.join('\n'));
    return true;
  }

  getCurrentPersonaName(groupId) {
    return groupPersonas.get(groupId) || config.ai?.defaultPersona || 'assistant';
  }

  getCurrentPersona(groupId) {
    const name = this.getCurrentPersonaName(groupId);
    return personas[name] || personas.assistant || '我是AI助手';
  }
}