import { 解析向日葵插件yaml, 保存yaml } from '../components/config.js';
import path from 'path';

const _path = process.cwd();

/**
 * 向日葵AI助手插件
 * 基于工作流的智能聊天机器人
 */
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
  }

  /** 初始化 */
  async init() {
    this.chatStream = null;
    // 获取聊天工作流
    this.chatStream = this.getStream('XRKChat');
    
    if (!this.chatStream) {
      logger.error('[XRK-AI] 聊天工作流未找到，请检查配置');
      return;
    }
    
    // 初始化工作流
    await this.chatStream.init();
    
    logger.info('[XRK-AI] AI助手初始化完成');
  }

  /** 主消息处理器 */
  async handleMessage(e) {
    try {
      // 管理命令
      if (e.isMaster && e.msg?.startsWith('#AI')) {
        return await this.handleAdminCommands(e);
      }

      // 交给工作流处理
      if (this.chatStream) {
        const result = await this.chatStream.processMessage(e, this.config);
        return result?.handled || false;
      }
      
    } catch (error) {
      logger.error(`[XRK-AI] 消息处理错误: ${error.message}`);
    }
    
    return false;
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
    else if (msg === '#AI重载') {
      await this.chatStream.init();
      await e.reply('AI工作流已重新加载');
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
#AI人设列表 - 查看可用人设
#AI添加全局 [群号] - 添加全局AI
#AI移除全局 [群号] - 移除全局AI
#AI查看全局 - 查看全局AI列表
#AI重载 - 重新加载工作流
#AI状态 - 查看运行状态

【功能说明】
• 触发方式：@机器人、前缀触发
• 全局AI：在白名单群自动参与聊天
• 触发概率：${(this.config.ai?.globalAIChance || 0.05) * 100}%
• 冷却时间：${this.config.ai?.globalAICooldown || 300}秒`;
    
    await e.reply(help);
    return true;
  }

  /** 切换人设 */
  async switchPersona(e, personaName) {
    if (!this.chatStream) {
      await e.reply('聊天工作流未初始化');
      return true;
    }
    
    const success = this.chatStream.switchPersona(e, personaName);
    if (success) {
      const emotionImage = this.chatStream.getRandomEmotionImage('开心');
      if (emotionImage) {
        await e.reply(segment.image(emotionImage));
      }
      await e.reply(`已切换到人设"${personaName}"`);
    } else {
      const personas = this.chatStream.getPersonaList();
      await e.reply(`未找到人设"${personaName}"\n可用：${personas.join('、')}`);
    }
    return true;
  }

  /** 人设列表 */
  async listPersonas(e) {
    if (!this.chatStream) {
      await e.reply('聊天工作流未初始化');
      return true;
    }
    
    const personas = this.chatStream.getPersonaList();
    await e.reply(`可用人设列表：\n${personas.join('、')}`);
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
      this.config = cfg;
      
      const emotionImage = this.chatStream?.getRandomEmotionImage('开心');
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
      this.config = cfg;
      
      const emotionImage = this.chatStream?.getRandomEmotionImage('伤心');
      if (emotionImage) {
        await e.reply(segment.image(emotionImage));
      }
      await e.reply(`已移除群${gid}的全局AI`);
    }
    return true;
  }

  /** 查看全局AI白名单 */
  async showGlobalWhitelist(e) {
    const list = this.config.ai?.globalWhitelist || [];
    const msg = list.length ? 
      `全局AI白名单：\n${list.map(g => `• ${g}`).join('\n')}` :
      '全局AI白名单为空';
    
    await e.reply(msg);
    return true;
  }

  /** 显示状态 */
  async showStatus(e) {
    const streamStatus = this.chatStream ? {
      name: this.chatStream.name,
      version: this.chatStream.version,
      messageCache: this.chatStream.messageHistory.size,
      userCache: this.chatStream.userCache.size,
      personas: this.chatStream.getPersonaList().length
    } : null;
    
    const status = [
      `【AI助手运行状态】`,
      streamStatus ? `• 工作流：${streamStatus.name} v${streamStatus.version}` : '• 工作流：未加载',
      streamStatus ? `• 消息缓存：${streamStatus.messageCache}个群` : '',
      streamStatus ? `• 用户缓存：${streamStatus.userCache}条` : '',
      streamStatus ? `• 人设数量：${streamStatus.personas}个` : '',
      `• 普通白名单群：${(this.config.ai?.whitelist?.groups || []).length}个`,
      `• 全局AI群：${(this.config.ai?.globalWhitelist || []).length}个`,
      `• 触发前缀：${this.config.ai?.triggerPrefix || '无'}`,
      `• 触发概率：${(this.config.ai?.globalAIChance || 0.05) * 100}%`,
      `• 冷却时间：${this.config.ai?.globalAICooldown || 300}秒`
    ].filter(line => line);
    
    await e.reply(status.join('\n'));
    return true;
  }
}