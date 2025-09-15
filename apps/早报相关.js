import plugin from '../../../lib/plugins/plugin.js';
import { 保存yaml, 解析向日葵插件yaml } from '../components/config.js';
import _ from 'lodash';

const _path = process.cwd();
const CONFIG_PATH = `${_path}/data/xrkconfig/config.yaml`;
const config = 解析向日葵插件yaml();

export class SettingsPlugin extends plugin {
  constructor() {
    super({
      name: '早报设置',
      dsc: '早报设置与自动推送功能',
      event: 'message',
      priority: _.get(config, 'priority.news', 500),
      rule: [
        { reg: '^#*早报添加白名单(\\d+)?$', fnc: 'addWhitelist' },
        { reg: '^#*早报删除白名单(\\d+)?$', fnc: 'removeWhitelist' },
        { reg: '^#*查看早报白名单$', fnc: 'showWhitelist' },
        { reg: '^#*修改早报推送时间(\\d+)$', fnc: 'setPushTime' }
      ]
    });

    this.task = {
      name: '每日早报推送',
      cron: `0 0 ${config.news_pushtime || 8} * * ?`,
      fnc: () => this.scheduledPush()
    };
  }

  async scheduledPush() {
    const API_URL = 'https://api.03c3.cn/api/zb';
    const DELAY = _.get(config, 'news.delay', 1000);

    try {
      const message = ["早安！这是今天的早报\n", segment.image(API_URL)];
      for (const groupId of config.news_groupss) {
        const group = Bot.pickGroup(groupId);
        if (group) await group.sendMsg(message) && await this.sleep(DELAY);
        else logger.error(`群组 ${groupId} 不存在`);
      }
    } catch (error) {
      logger.error('获取早报图片失败:', error);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async saveConfig() {
    try {
      await 保存yaml(CONFIG_PATH, config);
      return true;
    } catch (error) {
      logger.error('保存配置文件失败:', error);
      return false;
    }
  }

  async setPushTime(e) {
    if (!e.isMaster) return e.reply('只有主人才能命令我哦');
    const newTime = parseInt(e.msg.match(/修改早报推送时间(\d+)/)?.[1]);
    if (isNaN(newTime) || newTime < 0 || newTime > 23) return e.reply('请提供有效的时间（0-23）');
    config.news_pushtime = newTime;
    await this.saveConfig() ? e.reply(`已将早报推送时间修改为${newTime}点`) : e.reply('修改推送时间失败，请检查日志');
  }

  async addWhitelist(e) {
    if (!e.isMaster) return e.reply('只有主人才能命令我哦');
    const groupId = parseInt(e.msg.match(/早报添加白名单(\d+)?/)?.[1] || e.group_id);
    if (!groupId) return e.reply('请在群聊中使用此命令或指定群号');
    if (config.news_groupss.includes(groupId)) return e.reply('该群已在白名单中');
    config.news_groupss.push(groupId);
    await this.saveConfig() ? e.reply(`已将群${groupId}添加到早报白名单`) : e.reply('添加白名单失败，请检查日志');
  }

  async removeWhitelist(e) {
    if (!e.isMaster) return e.reply('只有主人才能命令我哦');
    const groupId = parseInt(e.msg.match(/早报删除白名单(\d+)?/)?.[1] || e.group_id);
    if (!groupId) return e.reply('请在群聊中使用此命令或指定群号');
    if (!config.news_groupss.includes(groupId)) return e.reply('该群不在白名单中');
    config.news_groupss = config.news_groupss.filter(id => id !== groupId);
    await this.saveConfig() ? e.reply(`已将群${groupId}从早报白名单中移除`) : e.reply('删除白名单失败，请检查日志');
  }

  async showWhitelist(e) {
    if (!e.isMaster) return e.reply('只有主人才能命令我哦');
    config.news_groupss.length ? e.reply(`当前早报白名单群号：\n${config.news_groupss.join('\n')}`) : e.reply('白名单为空');
  }
}