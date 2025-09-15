import plugin from '../../../lib/plugins/plugin.js';
import fs from 'fs';
import path from 'path';
import { takeScreenshot } from '../../../lib/common/takeScreenshot.js';

export class showHelp extends plugin {
  constructor() {
    super({
      name: '其他帮助',
      dsc: '向日葵帮助',
      event: 'message',
      priority: 500,
      rule: [
        { reg: /^#?(xrk|向日葵)?全局(表情)?帮助$/, fnc: 'emojihelp' },
        { reg: /^#?(xrk|向日葵)?刷步数帮助$/, fnc: 'feethelp' },
        { reg: /^#?(xrk|向日葵)?(早报)?推送帮助$/, fnc: 'newshelp' },
        { reg: /^#?(xrk|向日葵)?(整点)?报时帮助$/, fnc: 'timehelp' },
        { reg: /^#?(xrk|向日葵)?(人工)?(ai|AI|Ai|aI)帮助$/, fnc: 'aihelp' },
        { reg: /^#?(xrk|向日葵)?插件(相关)?帮助$/, fnc: 'pluginshelp' },
        { reg: /^#?(xrk|向日葵)?主人(相关)?帮助$/, fnc: 'masterhelp' }
      ],
    });
  }

  updateCSS(htmlPath) {
    const dir = path.dirname(htmlPath);

    const templateCssPath = path.join(dir, 'style_template.css');
    const styleCssPath = path.join(dir, 'style.css');
    let cssContent = fs.readFileSync(templateCssPath, 'utf-8');
    const bgotherDir = path.join(dir, 'bgother');
    const files = fs.readdirSync(bgotherDir);
    const imageFiles = files.filter(file => /\.(jpg|jpeg|png|gif|bmp)$/i.test(file));

    if (imageFiles.length === 0) {
      console.error('bgother目录中没有找到图片文件');
      return;
    }
    const randomIndex = Math.floor(Math.random() * imageFiles.length);
    const selectedImage = imageFiles[randomIndex];
    const imagePath = path.relative(dir, path.join(bgotherDir, selectedImage)).replace(/\\/g, '/');
    const newCssContent = cssContent.replace(/{{bgImagePath}}/g, imagePath);
    fs.writeFileSync(styleCssPath, newCssContent, 'utf-8');
  }

  async emojihelp(e) {
    const htmlPath = path.join(process.cwd(), '/plugins/XRK/resources/help/emoji-help.html');
    const imageName = 'emoji_help';

    try {
      // 更新CSS文件
      this.updateCSS(htmlPath);

      const imagePath = await takeScreenshot(htmlPath, imageName);
      await e.reply(segment.image(imagePath));
    } catch (error) {
      console.error('生成帮助截图失败:', error);
      await e.reply('生成帮助截图失败，请稍后再试。');
    }
  }

  // 图片相关帮助
  async feethelp(e) {
    const htmlPath = path.join(process.cwd(), '/plugins/XRK/resources/help/feet-help.html');
    const imageName = 'feet_help';

    try {
      this.updateCSS(htmlPath);
      const imagePath = await takeScreenshot(htmlPath, imageName);
      await e.reply(segment.image(imagePath));
    } catch (error) {
      console.error('生成帮助截图失败:', error);
      await e.reply('生成帮助截图失败，请稍后再试。');
    }
  }

  // 早报推送帮助
  async newshelp(e) {
    if (e.isMaster) {
      const htmlPath = path.join(process.cwd(), '/plugins/XRK/resources/help/news-help.html');
      const imageName = 'news_help';

      try {
        // 更新CSS文件
        this.updateCSS(htmlPath);

        const imagePath = await takeScreenshot(htmlPath, imageName);
        await e.reply(segment.image(imagePath));
      } catch (error) {
        console.error('生成帮助截图失败:', error);
        await e.reply('生成帮助截图失败，请稍后再试。');
      }
    } else {
      await e.reply('只有主人才能命令我哦');
    }
  }

  async timehelp(e) {
    if (e.isMaster) {
      const htmlPath = path.join(process.cwd(), '/plugins/XRK/resources/help/time-help.html');
      const imageName = 'time_help';

      try {
        // 更新CSS文件
        this.updateCSS(htmlPath);

        const imagePath = await takeScreenshot(htmlPath, imageName);
        await e.reply(segment.image(imagePath));
      } catch (error) {
        console.error('生成帮助截图失败:', error);
        await e.reply('生成帮助截图失败，请稍后再试。');
      }
    } else {
      await e.reply('只有主人才能命令我哦');
    }
  }

  async aihelp(e) {
    const htmlPath = path.join(process.cwd(), '/plugins/XRK/resources/help/ai-help.html');
    const imageName = 'ai_help';

    try {
      this.updateCSS(htmlPath);
      const imagePath = await takeScreenshot(htmlPath, imageName);
      await e.reply(segment.image(imagePath));
    } catch (error) {
      console.error('生成帮助截图失败:', error);
      await e.reply('生成帮助截图失败，请稍后再试。');
    }
  }

  async pluginshelp(e) {
    const htmlPath = path.join(process.cwd(), '/plugins/XRK/resources/help/plugins-help.html');
    const imageName = 'plugins_help';

    try {
      // 更新CSS文件
      this.updateCSS(htmlPath);

      const imagePath = await takeScreenshot(htmlPath, imageName);
      await e.reply(segment.image(imagePath));
    } catch (error) {
      console.error('生成帮助截图失败:', error);
      await e.reply('生成帮助截图失败，请稍后再试。');
    }
  }

  async masterhelp(e) {
    const htmlPath = path.join(process.cwd(), '/plugins/XRK/resources/help/master-help.html');
    const imageName = 'master_help';

    try {
      this.updateCSS(htmlPath);

      const imagePath = await takeScreenshot(htmlPath, imageName);
      await e.reply(segment.image(imagePath));
    } catch (error) {
      console.error('生成帮助截图失败:', error);
      await e.reply('生成帮助截图失败，请稍后再试。');
    }
  }
}