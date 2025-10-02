import path from 'path';
import BotUtil from '../../../lib/common/util.js';
import { 解析向日葵插件yaml, 保存yaml } from '../components/config.js';

const _path = process.cwd();
const PERSONAS_DIR = path.join(_path, 'plugins/XRK/config/ai-assistant/personas');

let config = null;
let personas = {};
const globalAIState = new Map();
const groupPersonas = new Map();

export class XRKAIAssistant extends plugin {
  constructor() {
    super({
      name: 'XRK-AI助手',
      dsc: '智能AI助手，支持群管理、表情包、识图等',
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
    await BotUtil.mkdir(PERSONAS_DIR);
    
    // 创建默认人设
    const defaultPersonaPath = path.join(PERSONAS_DIR, 'assistant.txt');
    if (!await BotUtil.fileExists(defaultPersonaPath)) {
      await BotUtil.writeFile(defaultPersonaPath, `我是${Bot.nickname}，一个智能AI助手。
我会认真观察群聊，适时发表评论和互动。
喜欢用表情回应别人的消息，也会戳一戳活跃气氛。
对不同的人有不同的态度，记得每个人的名字。
会根据聊天氛围选择合适的表情和互动方式。`);
    }
    
    personas = await this.loadPersonas();
    logger.info('[XRK-AI] AI助手初始化完成');
  }

  async handleMessage(e) {
    try {
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
    const isInWhitelist = () => {
      if (e.isGroup) {
        const groupWhitelist = (config.ai?.whitelist?.groups || []).map(id => Number(id));
        return groupWhitelist.includes(Number(e.group_id));
      } else {
        const userWhitelist = (config.ai?.whitelist?.users || []).map(id => Number(id));
        return userWhitelist.includes(Number(e.user_id));
      }
    };
    
    if (e.atBot) return isInWhitelist();
    
    const triggerPrefix = config.ai?.triggerPrefix;
    if (triggerPrefix !== undefined && triggerPrefix !== null && triggerPrefix !== '') {
      if (e.msg?.startsWith(triggerPrefix)) {
        return isInWhitelist();
      }
    }
    
    if (!e.isGroup) return false;
    
    const globalWhitelist = (config.ai?.globalWhitelist || []).map(id => Number(id));
    const groupIdNum = Number(e.group_id);
    
    if (!globalWhitelist.includes(groupIdNum)) return false;
    
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
      
      const isGlobalTrigger = !e.atBot && 
        (config.ai?.triggerPrefix === undefined || 
         config.ai?.triggerPrefix === null || 
         config.ai?.triggerPrefix === '' || 
         !e.msg?.startsWith(config.ai.triggerPrefix));
      
      let question = await this.processMessageContent(e);
      if (!isGlobalTrigger && !question && !e.img?.length) {
        const emotionImage = chatStream.getRandomEmotionImage('惊讶');
        if (emotionImage) {
          await e.reply(segment.image(emotionImage));
          await BotUtil.sleep(300);
        }
        await e.reply('有什么需要帮助的吗？');
        return true;
      }
      
      // 准备工作流上下文
      const groupId = e.group_id || `private_${e.user_id}`;
      const persona = this.getCurrentPersona(groupId);
      
      const questionContext = {
        text: question,
        persona: persona,
        isGlobalTrigger: isGlobalTrigger
      };
      
      // 调用工作流处理
      const result = await chatStream.process(e, questionContext, {
        baseUrl: config.ai?.baseUrl,
        apiKey: config.ai?.apiKey,
        model: config.ai?.chatModel,
        temperature: config.ai?.temperature || 0.8,
        maxTokens: config.ai?.max_tokens || 6000,
        topP: config.ai?.top_p || 0.9,
        presencePenalty: config.ai?.presence_penalty || 0.6,
        frequencyPenalty: config.ai?.frequency_penalty || 0.6
      });
      
      if (!result) {
        if (isGlobalTrigger) {
          return false;
        }
        return true;
      }

      await this.processStreamResponse(e, result, chatStream);
      return true;
    } catch (error) {
      logger.error(`[XRK-AI] AI处理失败: ${error.message}`);
      return false;
    }
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
            content += `[图片] `;
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
          }
        }
        
        // 发送文本
        if (segment.textParts.length > 0) {
          const msgSegments = [];
          for (const part of segment.textParts) {
            const cqSegments = await stream.parseCQCodes(part, e);
            msgSegments.push(...cqSegments);
          }
          
          if (msgSegments.length > 0) {
            await e.reply(msgSegments, Math.random() > 0.5);
          }
        }
        
        // 执行其他功能
        for (const func of segment.functions) {
          if (func.type !== 'emotion') {
            await stream.executeFunction(func, { e, stream });
          }
        }
        
        if (i < result.segments.length - 1) {
          await BotUtil.sleep(BotUtil.randomRange(800, 1500));
        }
      }
    } catch (error) {
      logger.error(`[XRK-AI] 处理工作流响应失败: ${error.message}`);
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
#AI重载人设 - 重新加载人设和表情包
#AI状态 - 查看运行状态

【功能说明】
• 触发方式：@机器人、前缀触发
• 全局AI：在白名单群自动参与聊天
• 工作流系统：支持多种AI处理模式`;
    
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
    const streams = this.getAllStreams();
    const chatStream = this.getStream('chat');
    
    const status = [
      `【AI助手运行状态】`,
      `• 工作流数量：${streams.length}个`,
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