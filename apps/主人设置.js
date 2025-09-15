import path from 'path';
import plugin from '../../../lib/plugins/plugin.js';
import Cfg from '../../../lib/config/config.js';
import YAML from 'yaml';
import fs from 'fs';

const ROOT_PATH = process.cwd();
const XRK_CONFIG_PATH = path.join(ROOT_PATH, 'data', 'xrkconfig', 'config.yaml');

const generateVerificationCode = () => {
  const digits = Math.floor(100000 + Math.random() * 900000).toString();
  const letters = Array.from({ length: 2 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  return digits + letters;
};

export class Example extends plugin {
  constructor() {
    super({
      name: '设置主人',
      dsc: '更为方便的设置主人',
      event: 'message',
      priority: 114514,
      rule: [
        {
          reg: '^#?主人添加[^:：]*(?:[:：]\\s*\\d+)?$',
          fnc: 'setMaster'
        },
        {
          reg: '^#?核心主人[^:：]*(?:[:：]\\s*\\d+)?$',
          fnc: 'setCoreMaster'
        },
        {
          reg: '^#?删主人[^:：]*(?:[:：]\\s*\\d+)?$',
          fnc: 'delMaster'
        },
        {
          reg: '^\\d{6}[A-Z]{2}$',
          fnc: 'handleVerification'
        }
      ]
    });
  }

  /**
   * 解析输入消息，提取目标QQ和Bot UIN
   * @param {Object} e - 事件对象
   * @returns {Object} - 包含 targetBotUin 和 targetQQ 的对象
   */
  parseInput(e) {
    const msg = e.msg.trim();
    const match = msg.match(/(\d+)[:：]\s*(\d+)/);
    let targetQQ, targetBotUin;
    if (match) {
      targetBotUin = Number(match[1]);
      targetQQ = Number(match[2]);
    } else {
      targetBotUin = e.self_id;
      targetQQ = Number(msg.match(/\d+/)?.[0]) || Number(e.message.find(item => item.type === 'at')?.qq) || null;
    }
    return { targetBotUin, targetQQ };
  }

  /**
   * 获取 xrkconfig 配置
   * @returns {Object} - xrkconfig 配置对象
   */
  getXrkConfig() {
    if (fs.existsSync(XRK_CONFIG_PATH)) {
      return YAML.parse(fs.readFileSync(XRK_CONFIG_PATH, 'utf8')) || {};
    }
    return {};
  }

  /**
   * 保存 xrkconfig 配置
   * @param {Object} config - 更新后的 xrkconfig 配置对象
   */
  saveXrkConfig(config) {
    const dir = path.dirname(XRK_CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(XRK_CONFIG_PATH, YAML.stringify(config), 'utf8');
  }

  /**
   * 保存并重载 other 配置
   * @param {Object} updatedConfig - 更新后的 other 配置对象
   */
  saveAndReloadOtherConfig(updatedConfig) {
    const port = Cfg._port;
    const otherConfigPath = path.join(ROOT_PATH, 'data', 'server_bots', String(port), 'other.yaml');
    fs.writeFileSync(otherConfigPath, YAML.stringify(updatedConfig), 'utf8');
    const key = `config.server.${port}.other`;
    delete Cfg.config[key];
    Cfg.getConfig('other');
  }

  /**
   * 添加主人（内部方法）
   * @param {Object} e - 事件对象
   * @param {number} targetQQ - 目标QQ
   */
  async setMasterInternal(e, targetQQ) {
    const otherConfig = Cfg.getConfig('other');
    otherConfig.masterQQ = otherConfig.masterQQ || [];

    if (otherConfig.masterQQ.includes(targetQQ)) {
      await e.reply('加过了还要加？！');
      return;
    }

    otherConfig.masterQQ.push(targetQQ);
    this.saveAndReloadOtherConfig(otherConfig);
    await e.reply([segment.at(targetQQ), '\n现在是主人了，呵']);
    logger.info(`添加主人成功：${targetQQ}`);
  }

  /**
   * 设置核心主人（内部方法）
   * @param {Object} e - 事件对象
   * @param {number} targetQQ - 目标QQ
   */
  async setCoreMasterInternal(e, targetQQ) {
    const otherConfig = Cfg.getConfig('other');
    const xrkConfig = this.getXrkConfig();
    otherConfig.masterQQ = otherConfig.masterQQ || [];

    xrkConfig.coremaster = targetQQ;
    if (!otherConfig.masterQQ.includes(targetQQ)) {
      otherConfig.masterQQ.push(targetQQ);
    }

    this.saveXrkConfig(xrkConfig);
    this.saveAndReloadOtherConfig(otherConfig);
    logger.info(`核心主人设置成功：${targetQQ}`);
    await e.reply(`已将 ${targetQQ} 设置为核心主人`);
  }

  /**
   * 添加主人
   * @param {Object} e - 事件对象
   */
  async setMaster(e) {
    const { targetQQ } = this.parseInput(e);
    if (targetQQ) {
      if (!e.isMaster) {
        await e.reply('只有主人才能添加其他主人');
        return;
      }
      await this.setMasterInternal(e, targetQQ);
    } else {
      const code = generateVerificationCode();
      const userId = e.user_id;
      const key = `verification:${userId}`;
      await redis.set(key, JSON.stringify({ code, timestamp: Date.now(), action: 'setMaster' }), 'EX', 300);
      logger.info(`请在聊天窗口中发送验证码：${code} 来确认添加主人`);
      await e.reply('请发送终端的验证码来确认添加主人');
    }
  }

  /**
   * 设置核心主人
   * @param {Object} e - 事件对象
   */
  async setCoreMaster(e) {
    if (e.user_id !== 'stdin') {
      await e.reply('只有 stdin 用户能设置核心主人');
      return;
    }
    const { targetQQ } = this.parseInput(e);
    if (targetQQ) {
      await this.setCoreMasterInternal(e, targetQQ);
    }
  }

  /**
   * 删除主人
   * @param {Object} e - 事件对象
   */
  async delMaster(e) {
    if (!e.isMaster) return;
    const { targetQQ } = this.parseInput(e);
    const otherConfig = Cfg.getConfig('other');
    const xrkConfig = this.getXrkConfig();
    otherConfig.masterQQ = otherConfig.masterQQ || [];

    if (targetQQ == xrkConfig.coremaster) {
      await e.reply('滚啊，你不能删核心主人');
      return;
    }
    if (targetQQ == e.user_id) {
      await e.reply('滚啊，你不能删除自己');
      return;
    }
    if (!otherConfig.masterQQ.includes(targetQQ)) {
      await e.reply('不是主人你还让我删?！！');
      return;
    }

    otherConfig.masterQQ = otherConfig.masterQQ.filter(qq => qq !== targetQQ);
    this.saveAndReloadOtherConfig(otherConfig);
    await e.reply([segment.at(targetQQ), '\n已经不是我的主人了哦']);
    logger.info(`删除主人成功：${targetQQ}`);
  }

  /**
   * 处理验证码
   * @param {Object} e - 事件对象
   */
  async handleVerification(e) {
    const code = e.msg.trim();
    const userId = e.user_id;
    const key = `verification:${userId}`;
    const verification = await redis.get(key);

    if (!verification) {
      await e.reply('没有待验证的验证码');
      return;
    }

    const { code: storedCode, timestamp, action } = JSON.parse(verification);
    if (Date.now() - timestamp > 5 * 60 * 1000) {
      await redis.del(key);
      await e.reply('验证码已过期');
      return;
    }

    if (code === storedCode) {
      await redis.del(key);
      if (action === 'setMaster') {
        await this.setMasterInternal(e, userId);
      }
    } else {
      await e.reply('验证码错误');
    }
  }
}