import plugin from '../../../lib/plugins/plugin.js';
import fs from 'fs';
import yaml from 'yaml';
import { 保存yaml } from '../components/config.js';

const _path = process.cwd();
const aiJsonPath = `${_path}/plugins/XRK/config/ai.json`;
const systemConfigPath = `${_path}/data/xrkconfig/config.yaml`;
const aiData = JSON.parse(fs.readFileSync(aiJsonPath, "utf8"));
let systemConfig = yaml.parse(fs.readFileSync(systemConfigPath, 'utf8'));

// 定义插件
export class ExamplePlugin extends plugin {
  constructor() {
    super({
      name: 'ai',
      dsc: '简单开发示例',
      event: 'message',
      priority: -1000,
      rule: [
        {
          reg: '.*',
          fnc: 'aiHandler',
          log: false
        },
        { reg: '^#开启向日葵ai$', fnc: 'activateAi' },
        { reg: '^#关闭向日葵ai$', fnc: 'deactivateAi' }
      ]
    });
  }

  async handleResponse(e) {
    const userMessage = e.msg;
    const responseKey = this.findMatch(userMessage, aiData);

    if (responseKey && aiData[responseKey]) {
      const responses = aiData[responseKey];
      const reply = responses[Math.floor(Math.random() * responses.length)];
      await e.reply(reply, true);
    }
  }

  findMatch(msg, json) {
    if (!msg) return null;
    return Object.keys(json).find(key => key === msg) || null;
  }

  async activateAi(e) {
    if (!e.isMaster) return;
    this.updateAiStatus(true);
    await e.reply('向日葵AI已开启');
  }

  async deactivateAi(e) {
    if (!e.isMaster) return;
    this.updateAiStatus(false);
    await e.reply('向日葵AI已关闭');
  }

  async aiHandler(e) {
    if (systemConfig.peopleai !== true) return false;
    if (e.img) return false;
    await this.handleResponse(e);
    return false;
  }

  updateAiStatus(status) {
    systemConfig.peopleai = status;
    保存yaml(systemConfigPath, systemConfig);
  }
}
