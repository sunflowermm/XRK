import { takeScreenshot } from '../../../lib/common/takeScreenshot.js';
import path from 'path';
import fs from 'fs';
import yaml from 'yaml';
import { helpCfg, helpList } from '../config/system/help_system.js';

const ROOT_PATH = process.cwd();
const mainPackage = JSON.parse(fs.readFileSync(path.join(ROOT_PATH, 'package.json'), 'utf-8'));
const pluginPackage = JSON.parse(fs.readFileSync(path.join(ROOT_PATH, 'plugins/XRK/package.json'), 'utf-8'));
const helpCONFIG = path.join(ROOT_PATH, 'data/xrkconfig/config.yaml');
let help_Config = yaml.parse(fs.readFileSync(helpCONFIG, 'utf8'));

function getRandomBackgroundImage() {
  const bgFolderPath = path.join(process.cwd(), 'plugins/XRK/resources/help/bg');
  const files = fs.readdirSync(bgFolderPath).filter(file => /\.(jpg|jpeg|png|gif)$/i.test(file));
  if (files.length === 0) {
    logger.error("没有找到背景图片");
  }
  const randomFile = files[Math.floor(Math.random() * files.length)];
  return `./bg/${randomFile}`;
}

function getIconPath(number) {
  return `./icons/icon-${number}.png`;
}

function filterHelpList() {
  const configPath = path.join(ROOT_PATH, 'data/xrkconfig/config.yaml');
  let config;
  try {
    config = yaml.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.error('读取配置文件失败:', error);
    return helpList;
  }

  return helpList.map(group => {
    if (group.group === '向日葵资源相关功能' && (!config.sharing || config.sharing !== true)) {
      return null;
    }
    return group;
  }).filter(Boolean); // Remove null entries
}

export class showmainHelp extends plugin {
  constructor() {
    super({
      name: '向日葵帮助插件',
      dsc: 'xrk帮助',
      event: 'message',
      priority: help_Config.help_priority,            
      rule: [
        { 
          reg: '^#?(xrk|向日葵)?(插件)?(帮助|help|Help|菜单|功能)',
          fnc: 'generateHelpScreenshot' 
        },
      ]
    });
  }

  async generateHelpScreenshot(e) {
    const templateHtmlPath = path.join(process.cwd(), 'plugins/XRK/resources/help/help_template.html');
    const templateCssPath = path.join(process.cwd(), 'plugins/XRK/resources/help/help_template.css');
    const htmlOutputPath = path.join(process.cwd(), 'plugins/XRK/resources/help/help.html');
    const cssOutputPath = path.join(process.cwd(), 'plugins/XRK/resources/help/help.css');
    const bgImagePath = getRandomBackgroundImage();

    // 读取 HTML 模板内容
    let htmlContent = fs.readFileSync(templateHtmlPath, 'utf-8');
    let cssContent = fs.readFileSync(templateCssPath, 'utf-8');
    cssContent = cssContent.replace('{{bgImagePath}}', bgImagePath);
    fs.writeFileSync(cssOutputPath, cssContent, 'utf-8');
    const filteredHelpList = filterHelpList();

    // 动态生成帮助内容的 HTML
    let helpSections = '';
    for (const group of filteredHelpList) {
      let sectionContent = `
        <div class="help-group">${group.group}</div>
        <div class="help-table">`;

      for (const item of group.list) {
        sectionContent += `
          <div class="td">
            <div class="help-icon" style="background-image: url('${getIconPath(item.icon)}');"></div>
            <div class="help-text">
              <div class="help-title">${item.title}</div>
              <div class="help-desc">${item.desc}</div>
            </div>
          </div>`;
      }
      sectionContent += `</div>`;
      helpSections += sectionContent;
    }

    // 替换模板中的占位符
    htmlContent = htmlContent
      .replace('{{title}}', helpCfg.title)
      .replace('{{subTitle}}', helpCfg.subTitle)
      .replace('{{helpSections}}', helpSections)
      .replace('{{mainPackageName}}', mainPackage.name)
      .replace('{{mainPackageVersion}}', mainPackage.version)
      .replace('{{pluginPackageName}}', pluginPackage.name)
      .replace('{{pluginPackageVersion}}', pluginPackage.version);
    fs.writeFileSync(htmlOutputPath, htmlContent, 'utf-8');

    try {
      const screenshotPath = await takeScreenshot(htmlOutputPath, 'help_screenshot');
      await e.reply([segment.image(screenshotPath)]);
    } catch (error) {
      console.error('生成帮助截图失败:', error);
      await e.reply('生成帮助截图失败，请稍后重试。');
      fs.unlinkSync(htmlOutputPath);
      fs.unlinkSync(cssOutputPath);
    }
  }
}