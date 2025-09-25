import path from 'path';
import plugin from '../../../lib/plugins/plugin.js';
import { 解析向日葵插件yaml, 保存yaml } from '../components/config.js';
import { 制作聊天记录 } from '../../../lib/common/util.js';

export class XrkSettings extends plugin {
  constructor() {
    super({
      name: '向日葵设置',
      dsc: '查看向日葵插件设置',
      event: 'message',
      priority: 100,
      rule: [
        { reg: '^#?(向日葵|xrk)设置$', fnc: 'showSettings' },
        { reg: '^#?(向日葵|xrk)修改帮助优先级(.*)$', fnc: 'setHelpPriority' },
        { reg: '^#?(向日葵|xrk)修改戳一戳优先级(.*)$', fnc: 'setChuoPriority' },
        { reg: '^#?(向日葵|xrk)修改戳一戳主人优先级(.*)$', fnc: 'setChuoMasterPriority' },
        { reg: '^#?(向日葵|xrk)(开启|关闭)戳一戳主人(.*)$', fnc: 'toggleChuoMaster' },
        { reg: '^#?(向日葵|xrk)修改渲染精度(.*)$', fnc: 'setRenderQuality' },
        { reg: '^#?(开启|关闭)(向日葵|xrk)?签名监测$', fnc: 'toggleSignChecker' },
        { reg: '^#?(向日葵|xrk)修改(ai|AI|Ai|aI)前缀(.*)$', fnc: 'setAiPrefix' },
        { reg: '^#?(向日葵|xrk)关闭前缀$', fnc: 'disableAiPrefix' },
        { reg: '^#?(向日葵|xrk)(开启|关闭)网页截图$', fnc: 'toggleScreenshot' },
        { reg: '^#?(向日葵|xrk)(开启|关闭)资源$', fnc: 'toggleSharing' },
        { reg: '^#?(向日葵|xrk)设置AI配置(.*)$', fnc: 'setAiConfig' },
        { reg: '^#?(向日葵|xrk)(开启|关闭)自定义AI$', fnc: 'toggleSelfControl' },
        { reg: '^#?(向日葵|xrk)设置AI(接口|模型|温度|令牌|惩罚|触发前缀|历史限制|默认人设)(.*)$', fnc: 'setAiParameter' },
        { reg: '^#?(向日葵|xrk)设置AI白名单(.*)$', fnc: 'setAiWhitelist' },
        { reg: '^#?(向日葵|xrk)设置全局AI(.*)$', fnc: 'setGlobalAi' }
      ]
    });
  }

  /** 读取配置文件 */
  readConfig() {
    return 解析向日葵插件yaml();
  }

  /** 保存配置到文件 */
  async saveConfig(config) {
    const configPath = path.join(process.cwd(), 'data/xrkconfig/config.yaml');
    try {
      保存yaml(configPath, config);
      return true;
    } catch (error) {
      console.error(`保存配置时出错: ${error.message}`);
      return false;
    }
  }

  /** 生成设置消息列表 */
  generateSettingsMessages(config, e) {
    const messages = [];

    messages.push('=== 向日葵插件设置 ===');

    // AI设置部分
    messages.push('【AI设置】');
    const prefixStatus = config.ai?.triggerPrefix || '未设置(需要@机器人)';
    messages.push([
      `❯ AI触发前缀: ${prefixStatus}\n└─ 发送\n【向日葵修改ai前缀xxx】\n来设置前缀\n└─ 发送\n【向日葵关闭前缀】\n来关闭前缀`,
      `❯ 自定义AI控制: ${config.selfcontrol ? '✅已开启' : '❌已关闭'}\n└─ 发送\n【#向日葵开启/关闭自定义AI】\n来更改设置`
    ].join('\n'));

    // 仅在自定义AI开启时显示详细设置
    if (config.selfcontrol) {
      const aiSettings = !e.isGroup
        ? `❯ AI接口设置:\n└─ API密钥: ${config.ai?.apiKey || '未设置'}\n└─ 接口地址: ${config.ai?.baseUrl || '未设置'}\n└─ 聊天模型: ${config.ai?.chatModel || '未设置'}\n└─ 视觉模型: ${config.ai?.visionModel || '未设置'}\n└─ 文件上传地址: ${config.ai?.fileUploadUrl || '未设置'}`
        : `❯ AI接口设置:\n└─ 接口地址: ${config.ai?.baseUrl || '未设置'}\n└─ 聊天模型: ${config.ai?.chatModel || '未设置'}\n└─ 视觉模型: ${config.ai?.visionModel || '未设置'}`;
      messages.push(aiSettings);

      messages.push(`❯ AI参数设置:\n└─ 最大令牌: ${config.ai?.max_tokens || '未设置'}\n└─ 温度: ${config.ai?.temperature || '未设置'}\n└─ Top P: ${config.ai?.top_p || '未设置'}\n└─ 存在惩罚: ${config.ai?.presence_penalty || '未设置'}\n└─ 频率惩罚: ${config.ai?.frequency_penalty || '未设置'}\n└─ 历史限制: ${config.ai?.historyLimit || 10}\n└─ 默认人设: ${config.ai?.defaultPersona || 'assistant'}`);

      // AI白名单设置
      messages.push(`❯ AI白名单设置:\n└─ 群白名单: ${config.ai?.whitelist?.groups?.join('、') || '无'}\n└─ 用户白名单: ${config.ai?.whitelist?.users?.join('、') || '无'}\n└─ 全局AI群: ${config.ai?.globalWhitelist?.join('、') || '无'}\n└─ 全局AI概率: ${(config.ai?.globalAIChance || 0.05) * 100}%\n└─ 全局AI冷却: ${config.ai?.globalAICooldown || 300}秒`);
    }

    // 戳一戳设置部分
    messages.push('【戳一戳设置】');
    messages.push([
      `❯ 戳一戳主人: ${config.chuomaster ? '✅已开启' : '❌已关闭'}\n└─ 发送\n【#向日葵开启/关闭戳一戳主人】\n来更改设置`,
      `❯ 戳一戳优先级: ${config.poke_priority}\n└─ 发送\n【#向日葵修改戳一戳优先级xxx】\n来更改(支持正负整数)`,
      `❯ 戳一戳主人优先级: ${config.corepoke_priority}\n└─ 发送\n【#向日葵修改戳一戳主人优先级xxx】\n来更改(支持正负整数)`
    ].join('\n'));

    // 基础设置部分
    messages.push('【基础设置】');
    messages.push([
      `❯ 向日葵人工AI状态: ${config.peopleai ? '✅已开启' : '❌已关闭'}\n└─ 发送\n【开启/关闭向日葵ai】\n来更改设置`,
      `❯ 帮助优先级: ${config.help_priority}\n└─ 发送\n【#向日葵修改帮助优先级xxx】\n来更改(支持正负整数)`,
      `❯ 渲染精度: ${config.screen_shot_quality}\n└─ 发送\n【#向日葵修改渲染精度x.xx】\n来更改(1-3之间，支持两位小数)`,
      `❯ 签名监测: ${config.signchecker ? '✅已开启' : '❌已关闭'}\n└─ 发送\n【开启/关闭向日葵签名监测】\n来更改设置`,
      `❯ 网页截图: ${config.screen_shot_http ? '✅已开启' : '❌已关闭'}\n└─ 发送\n【#向日葵开启/关闭网页截图】\n来更改设置`,
      `❯ 资源分享: ${config.sharing ? '✅已开启' : '❌已关闭'}\n└─ 发送\n【#向日葵开启/关闭资源】\n来更改设置`
    ].join('\n'));

    // 推送设置部分
    messages.push('【推送设置】');
    messages.push([
      `❯ 整点报时推送群:\n${config.time_groupss?.length > 0 ? config.time_groupss.map(g => `└─ ${g}`).join('\n') : '└─ 暂无白名单群'}\n发送\n【整点报时添加/删除白名单】\n来更改设置`,
      `❯ 早报推送群:\n${config.news_groupss?.length > 0 ? config.news_groupss.map(g => `└─ ${g}`).join('\n') : '└─ 暂无白名单群'}\n发送\n【早报添加/删除白名单】\n来更改设置`,
      `❯ 早报推送时间: ${config.news_pushtime}点\n└─ 发送\n【#修改早报推送时间xxx】\n来更改设置`
    ].join('\n'));

    // 权限设置部分
    messages.push('【权限设置】');
    const masterInfo = this.generateMasterInfo(config);
    messages.push(masterInfo);
    messages.push(`❯ 核心主人: ${config.coremaster}\n└─ 使用stdin身份发送\n【#核心主人(主人qq)】来更改`);

    // 其他设置部分
    messages.push('【其他设置】');
    messages.push(`❯ 全局表情目录: ${config.emoji_filename}\n└─ 发送\n【偷图设置目录】来更改`);

    return messages;
  }

  /** 生成主人信息文本 */
  generateMasterInfo(config) {
    let masterMsg = '❯ 向日葵主人设置:';
    if (config.master) {
      let hasMasters = false;
      for (const [botId, masters] of Object.entries(config.master)) {
        if (masters?.length > 0 && botId !== 'stdin') {
          hasMasters = true;
          masterMsg += `\n${botId}的主人：\n${masters.map(m => `└─ ${m}`).join('\n')}`;
        }
      }
      if (!hasMasters) masterMsg += '\n└─ 暂无主人设置';
    } else {
      masterMsg += '\n└─ 暂无主人设置';
    }
    masterMsg += '\n发送\n【#主人添加(Botqq:主人qq)】\n或\n【#主人添加(主人qq)】来更改';
    return masterMsg;
  }

  /** 显示设置 */
  async showSettings(e) {
    if (!e.isMaster) return await e.reply('❌ 您没有权限执行此操作');
    const config = this.readConfig();
    if (!config) return await e.reply('读取配置文件失败');
    const messages = this.generateSettingsMessages(config, e);
    await 制作聊天记录(e, messages, '向日葵设置', ['笨比笨比一个一个字看准了！']);
  }

  // ... 其他方法保持不变 ...

  /** 设置AI前缀 */
  async setAiPrefix(e) {
    if (!e.isMaster) return await e.reply('❌ 您没有权限执行此操作');
    const prefix = e.msg.replace(/^#?(向日葵|xrk)修改(ai|AI|Ai|aI)前缀/, '').trim();
    if (!prefix) return await e.reply('❌ 请输入有效的前缀');

    const config = this.readConfig();
    if (!config) return await e.reply('读取配置文件失败');
    if (!config.ai) config.ai = {};

    config.ai.triggerPrefix = prefix;
    await e.reply(await this.saveConfig(config)
      ? `✅ AI触发前缀已设置为: ${prefix}，重启机器人生效`
      : '❌ 保存配置失败');
  }

  /** 关闭AI前缀 */
  async disableAiPrefix(e) {
    if (!e.isMaster) return await e.reply('❌ 您没有权限执行此操作');

    const config = this.readConfig();
    if (!config) return await e.reply('读取配置文件失败');
    if (!config.ai) config.ai = {};

    config.ai.triggerPrefix = '';
    await e.reply(await this.saveConfig(config)
      ? '✅ 已关闭AI前缀，现在将只通过@机器人触发AI聊天。发送【向日葵修改ai前缀xxx】可重新设置前缀，重启机器人生效'
      : '❌ 保存配置失败');
  }

  /** 设置AI参数 */
  async setAiParameter(e) {
    if (!e.isMaster) return await e.reply('❌ 您没有权限执行此操作');

    const config = this.readConfig();
    if (!config) return await e.reply('读取配置文件失败');

    if (!config.selfcontrol) return await e.reply('❌ 请先开启自定义AI控制');
    if (!config.ai) config.ai = {};

    const msg = e.msg;

    try {
      if (msg.includes('接口')) {
        const params = msg.replace(/^#?(向日葵|xrk)设置AI接口/, '').trim().split(',');
        if (params.length < 2) return await e.reply('❌ 请按格式输入: #向日葵设置AI接口接口地址,API密钥[,文件上传地址]');
        config.ai.baseUrl = params[0];
        config.ai.apiKey = params[1];
        if (params[2]) config.ai.fileUploadUrl = params[2];
      } else if (msg.includes('模型')) {
        const params = msg.replace(/^#?(向日葵|xrk)设置AI模型/, '').trim().split(',');
        if (params.length < 1) return await e.reply('❌ 请输入模型名称');
        config.ai.chatModel = params[0];
        if (params[1]) config.ai.visionModel = params[1];
      } else if (msg.includes('温度')) {
        const temp = parseFloat(msg.replace(/^#?(向日葵|xrk)设置AI温度/, '').trim());
        if (isNaN(temp) || temp < 0 || temp > 2) return await e.reply('❌ 温度值应在0-2之间');
        config.ai.temperature = temp;
      } else if (msg.includes('令牌')) {
        const tokens = parseInt(msg.replace(/^#?(向日葵|xrk)设置AI令牌/, '').trim());
        if (isNaN(tokens) || tokens < 1) return await e.reply('❌ 请输入有效的令牌数量');
        config.ai.max_tokens = tokens;
      } else if (msg.includes('惩罚')) {
        const params = msg.replace(/^#?(向日葵|xrk)设置AI惩罚/, '').trim().split(',');
        if (params.length < 2 || isNaN(Number(params[0])) || isNaN(Number(params[1]))) {
          return await e.reply('❌ 请按格式输入: #向日葵设置AI惩罚存在惩罚值,频率惩罚值');
        }
        config.ai.presence_penalty = Number(params[0]);
        config.ai.frequency_penalty = Number(params[1]);
      } else if (msg.includes('触发前缀')) {
        config.ai.triggerPrefix = msg.replace(/^#?(向日葵|xrk)设置AI触发前缀/, '').trim();
      } else if (msg.includes('历史限制')) {
        const limit = parseInt(msg.replace(/^#?(向日葵|xrk)设置AI历史限制/, '').trim());
        if (isNaN(limit) || limit < 1) return await e.reply('❌ 请输入有效的历史限制数量');
        config.ai.historyLimit = limit;
      } else if (msg.includes('默认人设')) {
        config.ai.defaultPersona = msg.replace(/^#?(向日葵|xrk)设置AI默认人设/, '').trim();
      }

      await e.reply(await this.saveConfig(config)
        ? '✅ AI参数设置成功'
        : '❌ 保存配置失败');
    } catch (error) {
      await e.reply(`❌ 设置失败: ${error.message}`);
    }
  }

  /** 设置AI白名单 */
  async setAiWhitelist(e) {
    if (!e.isMaster) return await e.reply('❌ 您没有权限执行此操作');

    const config = this.readConfig();
    if (!config) return await e.reply('读取配置文件失败');
    if (!config.ai) config.ai = {};
    if (!config.ai.whitelist) config.ai.whitelist = { groups: [], users: [] };

    const params = e.msg.replace(/^#?(向日葵|xrk)设置AI白名单/, '').trim();
    
    try {
      const data = JSON.parse(params);
      if (data.groups) config.ai.whitelist.groups = data.groups;
      if (data.users) config.ai.whitelist.users = data.users;
      
      await e.reply(await this.saveConfig(config)
        ? '✅ AI白名单设置成功'
        : '❌ 保存配置失败');
    } catch (error) {
      await e.reply('❌ 请使用JSON格式，如: {"groups":["123456"],"users":["789012"]}');
    }
  }

  /** 设置全局AI */
  async setGlobalAi(e) {
    if (!e.isMaster) return await e.reply('❌ 您没有权限执行此操作');

    const config = this.readConfig();
    if (!config) return await e.reply('读取配置文件失败');
    if (!config.ai) config.ai = {};

    const params = e.msg.replace(/^#?(向日葵|xrk)设置全局AI/, '').trim();
    
    try {
      const data = JSON.parse(params);
      if (data.whitelist) config.ai.globalWhitelist = data.whitelist;
      if (data.chance !== undefined) config.ai.globalAIChance = data.chance;
      if (data.cooldown !== undefined) config.ai.globalAICooldown = data.cooldown;
      
      await e.reply(await this.saveConfig(config)
        ? '✅ 全局AI设置成功'
        : '❌ 保存配置失败');
    } catch (error) {
      await e.reply('❌ 请使用JSON格式，如: {"whitelist":["123456"],"chance":0.05,"cooldown":300}');
    }
  }

  // 保留其他原有方法...
  async setHelpPriority(e) {
    if (!e.isMaster) return await e.reply('❌ 您没有权限执行此操作');
    const priority = parseInt(e.msg.replace(/^#?(向日葵|xrk)修改帮助优先级/, '').trim());
    if (isNaN(priority) || priority % 1 !== 0) return await e.reply('❌ 请输入有效的整数数值');

    const config = this.readConfig();
    if (!config) return await e.reply('读取配置文件失败');

    config.help_priority = priority;
    await e.reply(await this.saveConfig(config)
      ? `✅ 帮助优先级已修改为: ${priority}`
      : '❌ 保存配置失败');
  }

  async setChuoPriority(e) {
    if (!e.isMaster) return await e.reply('❌ 您没有权限执行此操作');
    const priority = parseInt(e.msg.replace(/^#?(向日葵|xrk)修改戳一戳优先级/, '').trim());
    if (isNaN(priority) || priority % 1 !== 0) return await e.reply('❌ 请输入有效的整数数值');

    const config = this.readConfig();
    if (!config) return await e.reply('读取配置文件失败');

    config.poke_priority = priority;
    await e.reply(await this.saveConfig(config)
      ? `✅ 戳一戳优先级已修改为: ${priority}`
      : '❌ 保存配置失败');
  }

  async setChuoMasterPriority(e) {
    if (!e.isMaster) return await e.reply('❌ 您没有权限执行此操作');
    const priority = parseInt(e.msg.replace(/^#?(向日葵|xrk)修改戳一戳主人优先级/, '').trim());
    if (isNaN(priority) || priority % 1 !== 0) return await e.reply('❌ 请输入有效的整数数值');

    const config = this.readConfig();
    if (!config) return await e.reply('读取配置文件失败');

    config.corepoke_priority = priority;
    await e.reply(await this.saveConfig(config)
      ? `✅ 戳一戳主人优先级已修改为: ${priority}`
      : '❌ 保存配置失败');
  }

  async toggleChuoMaster(e) {
    if (!e.isMaster) return await e.reply('❌ 您没有权限执行此操作');
    const isEnable = e.msg.includes('开启');

    const config = this.readConfig();
    if (!config) return await e.reply('读取配置文件失败');

    if (config.chuomaster === isEnable) return await e.reply(`戳一戳主人已${isEnable ? '开启' : '关闭'}, 无需重复操作`);

    config.chuomaster = isEnable;
    await e.reply(await this.saveConfig(config)
      ? `✅ 戳一戳主人已${isEnable ? '开启' : '关闭'}`
      : '❌ 保存配置失败');
  }

  async setRenderQuality(e) {
    if (!e.isMaster) return await e.reply('❌ 您没有权限执行此操作');
    const quality = parseFloat(e.msg.replace(/^#?(向日葵|xrk)修改渲染精度/, '').trim());
    if (isNaN(quality) || quality < 1 || quality > 3 || !/^\d+(\.\d{0,2})?$/.test(quality.toString())) {
      return await e.reply('❌ 请输入1-3之间的数值，最多支持两位小数');
    }

    const config = this.readConfig();
    if (!config) return await e.reply('读取配置文件失败');

    config.screen_shot_quality = quality;
    await e.reply(await this.saveConfig(config)
      ? `✅ 渲染精度已修改为: ${quality}`
      : '❌ 保存配置失败');
  }

  async toggleSignChecker(e) {
    if (!e.isMaster) return await e.reply('❌ 您没有权限执行此操作');
    const isEnable = e.msg.includes('开启');

    const config = this.readConfig();
    if (!config) return await e.reply('读取配置文件失败');

    config.signchecker = isEnable;
    await e.reply(await this.saveConfig(config)
      ? `✅ 签名监测已${isEnable ? '开启' : '关闭'}`
      : '❌ 保存配置失败');
  }

  async toggleScreenshot(e) {
    if (!e.isMaster) return await e.reply('❌ 您没有权限执行此操作');
    const isEnable = e.msg.includes('开启');

    const config = this.readConfig();
    if (!config) return await e.reply('读取配置文件失败');

    if (config.screen_shot_http === isEnable) return await e.reply(`网页截图已${isEnable ? '开启' : '关闭'}, 无需重复操作`);

    config.screen_shot_http = isEnable;
    await e.reply(await this.saveConfig(config)
      ? `✅ 网页截图已${isEnable ? '开启' : '关闭'}`
      : '❌ 保存配置失败');
  }

  async toggleSharing(e) {
    if (!e.isMaster) return await e.reply('❌ 您没有权限执行此操作');
    const isEnable = e.msg.includes('开启');

    const config = this.readConfig();
    if (!config) return await e.reply('读取配置文件失败');

    if (config.sharing === isEnable) return await e.reply(`资源分享已${isEnable ? '开启' : '关闭'}, 无需重复操作`);

    config.sharing = isEnable;
    await e.reply(await this.saveConfig(config)
      ? `✅ 资源分享已${isEnable ? '开启' : '关闭'}`
      : '❌ 保存配置失败');
  }

  async toggleSelfControl(e) {
    if (!e.isMaster) return await e.reply('❌ 您没有权限执行此操作');
    const isEnable = e.msg.includes('开启');

    const config = this.readConfig();
    if (!config) return await e.reply('读取配置文件失败');

    config.selfcontrol = isEnable;
    await e.reply(await this.saveConfig(config)
      ? `✅ 自定义AI控制已${isEnable ? '开启' : '关闭'}`
      : '❌ 保存配置失败');
  }

  async setAiConfig(e) {
    if (!e.isMaster) return await e.reply('❌ 您没有权限执行此操作');

    const config = this.readConfig();
    if (!config) return await e.reply('读取配置文件失败');

    if (!config.selfcontrol) return await e.reply('❌ 请先开启自定义AI控制');

    try {
      const configStr = e.msg.replace(/^#?(向日葵|xrk)设置AI配置/, '').trim();
      const configObj = JSON.parse(configStr);

      if (!config.ai) config.ai = {};
      Object.assign(config.ai, configObj);

      await e.reply(await this.saveConfig(config)
        ? '✅ AI配置已更新成功'
        : '❌ 保存配置失败');
    } catch (error) {
      await e.reply('❌ 配置格式错误，请使用正确的JSON格式');
    }
  }
}