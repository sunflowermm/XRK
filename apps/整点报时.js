import plugin from '../../../lib/plugins/plugin.js';
import moment from 'moment';
import fs from 'fs';
import yaml from 'yaml';
import path from 'path';

const ROOT_PATH = process.cwd();
const PLUGIN_PATH = path.join(ROOT_PATH, 'plugins/XRK');
const CONFIG_PATH = path.join(ROOT_PATH, 'data/xrkconfig/config.yaml');
const TIME_CONFIG_PATH = path.join(PLUGIN_PATH, 'config/time_config.json');
const IMAGE_DIR_PATH = path.join(PLUGIN_PATH, 'resources/emoji/整点报时图库');

export class WhitelistManager extends plugin {
  constructor() {
    super({
      name: '整点报时与白名单管理',
      dsc: '管理整点报时白名单及定时报时功能',
      event: 'message',
      priority: 5,
      rule: [
        { reg: /^#整点报时添加白名单(\d+)?$/, fnc: 'addGroup' },
        { reg: /^#整点报时删除白名单(\d+)?$/, fnc: 'removeGroup' },
        { reg: /^#查看整点报时白名单$/, fnc: 'showGroups' }
      ]
    });
    this.task = { name: '整点报时任务', cron: '0 0 * * * *', fnc: () => this.hourlyNotification() };
    this.loadConfigs();
  }

  loadConfigs() {
    this.config = yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    this.timeConfig = JSON.parse(fs.readFileSync(TIME_CONFIG_PATH, 'utf8'));
  }

  getRandomItem(array) {
    return array[Math.floor(Math.random() * array.length)];
  }

  getRandomEmoji() {
    return this.getRandomItem(this.timeConfig.emojis);
  }

  async getRandomFile(dirPath, fileTypes) {
    const files = await fs.promises.readdir(dirPath).catch(err => (logger.error(`获取随机文件失败 (${dirPath}):`, err), []));
    const validFiles = files.filter(file => new RegExp(`\\.(${fileTypes})$`, 'i').test(file));
    return validFiles.length ? path.join(dirPath, this.getRandomItem(validFiles)) : null;
  }

  async saveConfig() {
    return await fs.promises.writeFile(CONFIG_PATH, yaml.stringify(this.config)).then(() => true).catch(err => (logger.error('保存配置失败:', err), false));
  }

  async checkMasterPermission(e) {
    if (!e.isMaster) await e.reply('只有主人才能命令我哦 ' + this.getRandomEmoji());
    return e.isMaster;
  }

  extractGroupId(e) {
    return parseInt(e.msg.match(/(\d+)?$/)?.[1] || e.group_id, 10);
  }

  async addGroup(e) {
    if (!await this.checkMasterPermission(e)) return;
    const groupId = this.extractGroupId(e);
    if (!groupId) return e.reply('请在群聊中使用此命令或指定群号 ' + this.getRandomEmoji());
    if (this.config.time_groupss.includes(groupId)) return e.reply(`群号 ${groupId} 已经在白名单中呢 ${this.getRandomEmoji()}`);
    this.config.time_groupss.push(groupId);
    await this.saveConfig() ? e.reply(`已添加群号 ${groupId} 到整点报时白名单 ${this.getRandomEmoji()}`) : e.reply('添加失败，请检查日志 ' + this.getRandomEmoji());
  }

  async removeGroup(e) {
    if (!await this.checkMasterPermission(e)) return;
    const groupId = this.extractGroupId(e);
    if (!groupId) return e.reply('请在群聊中使用此命令或指定群号 ' + this.getRandomEmoji());
    if (!this.config.time_groupss.includes(groupId)) return e.reply(`群号 ${groupId} 不在白名单中呢 ${this.getRandomEmoji()}`);
    this.config.time_groupss = this.config.time_groupss.filter(g => g !== groupId);
    await this.saveConfig() ? e.reply(`已从整点报时白名单中删除群号 ${groupId} ${this.getRandomEmoji()}`) : e.reply('删除失败，请检查日志 ' + this.getRandomEmoji());
  }

  async showGroups(e) {
    if (!await this.checkMasterPermission(e)) return;
    const groups = this.config.time_groupss;
    await e.reply(groups.length ? `当前整点报时白名单中的群号有：${groups.join(', ')} ${this.getRandomEmoji()}` : `当前整点报时白名单为空呢~ ${this.getRandomEmoji()}`);
  }

  async notifyGroup(groupId, hours) {
    const message = this.getRandomItem(this.timeConfig.timeMessages).replace('{hours}', hours).replace('{botName}', Bot.nickname);
    const messages = [`${message} ${this.getRandomEmoji()}`];
    const imgPath = await this.getRandomFile(IMAGE_DIR_PATH, 'jpg|jpeg|png|gif|bmp');
    const group = Bot.pickGroup(groupId);
    try { await group.sendMsg({ type: "poke", id: Math.floor(Math.random() * 7) }); } catch {}
    await group.sendMsg(messages);
    if (imgPath) await group.sendMsg(segment.image(imgPath));
  }

  async hourlyNotification() {
    if (!this.config.time_groupss?.length) return;
    const currentHour = moment().hour();
    for (const groupId of this.config.time_groupss) {
      await this.notifyGroup(groupId, currentHour);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}