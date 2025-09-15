import plugin from "../../../lib/plugins/plugin.js";
import fs from "fs";
import path from "path";

const GLOBAL_SETTINGS_PATH = path.join(process.cwd(), '/plugins/XRK/config/group-settings');

if (!fs.existsSync(GLOBAL_SETTINGS_PATH)) {
    fs.mkdirSync(GLOBAL_SETTINGS_PATH, { recursive: true });
}

export async function getGroupSettings(groupId) {
    const filePath = path.join(GLOBAL_SETTINGS_PATH, `${groupId}.json`);
    try {
        if (!fs.existsSync(filePath)) {
            return { probability: 0 };
        }
        const data = await fs.promises.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('读取群设置时出错:', error);
        return { probability: 0 };
    }
}

export async function updateGroupSettings(groupId, data) {
    const filePath = path.join(GLOBAL_SETTINGS_PATH, `${groupId}.json`);
    try {
        await fs.promises.writeFile(filePath, JSON.stringify(data), 'utf8');
    } catch (error) {
        console.error('写入群设置时出错:', error);
    }
}

export class GlobalEmojiSettingsPlugin extends plugin {
    constructor() {
        super({
            name: "全局表情设置",
            dsc: "管理全局表情的设置",
            event: "message",
            priority: -1000000,
            rule: [
                {
                    reg: '^#开启全局表情$',
                    fnc: 'enableGlobalEmoji'
                },
                {
                    reg: '^#关闭全局表情$',
                    fnc: 'disableGlobalEmoji'
                },
                {
                    reg: '^#设置全局表情概率(\\d+(\\.\\d+)?)$',
                    fnc: 'setGlobalEmojiProbability'
                }
            ],
        });
    }

    async enableGlobalEmoji(e) {
        if (!e.isMaster) return;
        const groupId = this.e.group_id;
        const settings = { probability: 0.1 };
        await updateGroupSettings(groupId, settings);
        await e.reply('全局表情已开启，触发概率为10%', false, { recallMsg: 5 });
    }

    async disableGlobalEmoji(e) {
        if (!e.isMaster) return;
        const groupId = this.e.group_id;
        const settings = await getGroupSettings(groupId);
        settings.probability = 0;
        await updateGroupSettings(groupId, settings);
        await e.reply('全局表情已关闭', false, { recallMsg: 5 });
    }

    async setGlobalEmojiProbability(e) {
        if (!e.isMaster) return;
        const groupId = this.e.group_id;
        const match = e.msg.match(/^#设置全局表情概率(\d+(?:\.\d+)?)$/);
        if (match) {
            const newProbability = parseFloat(match[1]);
            if (newProbability < 0 || newProbability > 1) {
                await e.reply('概率应在0到1之间', false, { recallMsg: 5 });
                return;
            }
            const settings = await getGroupSettings(groupId);
            settings.probability = newProbability;
            await updateGroupSettings(groupId, settings);
            await e.reply(`全局表情概率已设置为 ${(newProbability * 100).toFixed(0)}%`, false, { recallMsg: 5 });
        } else {
            await e.reply('请使用正确格式：#设置全局表情概率[0-1]', false, { recallMsg: 5 });
        }
    }
}