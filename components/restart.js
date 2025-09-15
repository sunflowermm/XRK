import { Restart } from '../../other/restart.js';

/**
 * 重启Bot
 * @param {Object} e - 消息事件对象
 * @param {Array} installedPlugins - 已安装的插件列表，用于在重启后发送通知
 * @returns {Promise<boolean>} - 返回重启是否成功
 */
export async function restart(e, installedPlugins = []) {
    await e.reply('🔄 正在重启机器人，请稍候...');
    if (installedPlugins.length > 0) {
      const pluginMsg = `刚刚在${e.group_id ? `群 ${e.group_id} 中` : '私聊'}安装了以下插件：\n${installedPlugins.join('、')}`;
      await Bot.sendMasterMsg(pluginMsg);
    }
    logger.mark('正在执行重启，请稍等...');
    setTimeout(() => new Restart(e).restart(), 2000);
    return true;
}