import path from 'path';
import { 解析向日葵插件yaml, 保存yaml } from '../components/config.js';

const _path = process.cwd();

// 全局存储
const groupPersonas = new Map();
const userCache = new Map();

// 目录路径
const PERSONAS_DIR = path.join(_path, 'plugins/XRK/config/ai-assistant/personas');
const EMOTIONS_DIR = path.join(_path, 'plugins/XRK/config/ai-assistant');

// 配置和人设
let config = null;
let personas = {};

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
    this.chatStream = null;
  }

  /** 初始化 */
  async init() {
    // 创建目录
    await Bot.mkdir(PERSONAS_DIR);
    await Bot.mkdir(EMOTIONS_DIR);
    
    // 创建表情包目录
    const EMOTION_TYPES = ['开心', '惊讶', '伤心', '大笑', '害怕', '生气'];
    for (const emotion of EMOTION_TYPES) {
      const emotionDir = path.join(EMOTIONS_DIR, emotion);
      await Bot.mkdir(emotionDir);
    }
    
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
    
    // 获取聊天工作流
    this.chatStream = this.getStream('XRKChat');
    
    // 定期清理缓存
    setInterval(() => this.cleanupCache(), 300000); // 5分钟
    
    logger.info('[XRK-AI] AI助手初始化完成');
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

  /** 主消息处理器 */
  async handleMessage(e) {
    try {
      // 管理命令
      if (e.isMaster && e.msg?.startsWith('#AI')) {
        return await this.handleAdminCommands(e);
      }

      // 通过工作流判断是否触发AI
      if (!this.chatStream) {
        this.chatStream = this.getStream('XRKChat');
        if (!this.chatStream) {
          logger.error('[XRK-AI] 聊天工作流未加载');
          return false;
        }
      }

      // 准备上下文
      const groupId = e.group_id || `private_${e.user_id}`;
      const persona = this.getCurrentPersona(groupId);
      
      const context = {
        e,
        config,
        persona,
        personas,
        groupPersonas,
        userCache,
        EMOTIONS_DIR,
        groupId,
        isMaster: e.isMaster,
        getBotRole: () => this.getBotRole(e)
      };

      // 使用工作流处理消息
      const shouldTrigger = await this.chatStream.shouldTriggerAI(e, config);
      if (!shouldTrigger) {
        return false;
      }

      // 调用AI并处理响应
      const result = await this.processWithStream(e, context);
      return result;
      
    } catch (error) {
      logger.error(`[XRK-AI] 消息处理错误: ${error.message}`);
    }
    
    return false;
  }

  /** 使用工作流处理消息 */
  async processWithStream(e, context) {
    try {
      // 构建AI消息
      const aiContext = await this.chatStream.buildAIContext(e, context);
      
      // 调用AI
      const aiResult = await this.callAIStream(
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
        this.chatStream,
        aiContext.systemPrompt,
        {
          e,
          question: aiContext.question,
          history: aiContext.history,
          ...context
        }
      );

      if (!aiResult.success) {
        if (aiContext.isGlobalTrigger) {
          logger.debug('[XRK-AI] 全局AI响应失败，静默处理');
          return false;
        }
        return true;
      }

      // 处理AI响应
      await this.chatStream.processResponse(e, aiResult.response, context);
      return true;
      
    } catch (error) {
      logger.error(`[XRK-AI] 工作流处理失败: ${error.message}`);
      return false;
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
      await this.chatStream?.loadEmotionImages();
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
    const streamStatus = this.chatStream ? this.chatStream.getStatus() : null;
    
    const status = [
      `【AI助手运行状态】`,
      `• 用户缓存：${userCache.size}条`,
      `• 普通白名单群：${(config.ai?.whitelist?.groups || []).length}个`,
      `• 全局AI群：${(config.ai?.globalWhitelist || []).length}个`,
      `• 触发前缀：${config.ai?.triggerPrefix || '无'}`,
      `• 触发概率：${(config.ai?.globalAIChance || 0.05) * 100}%`,
      `• 冷却时间：${config.ai?.globalAICooldown || 300}秒`,
      `• 人设数量：${Object.keys(personas).length}个`,
      streamStatus ? `• 工作流状态：${streamStatus.name} v${streamStatus.version}` : ''
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

  /** 清理缓存 */
  cleanupCache() {
    const now = Date.now();
    
    // 清理用户缓存
    for (const [key, data] of userCache.entries()) {
      if (now - data.time > 300000) { // 5分钟
        userCache.delete(key);
      }
    }
    
    logger.debug(`[XRK-AI] 缓存清理完成`);
  }
}