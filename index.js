import fs from 'fs';
import yaml from 'yaml';
import path from 'path';
import chalk from 'chalk';

// ========== 检查依赖是否缺失 ==========
async function checkDependencies() {
  for (let i of ['axios', 'uuid', 'crypto', 'form-data', 'sqlite', 'node-schedule']) {
    try {
      await import(i);
    } catch (error) {
      if (error.stack?.includes('Cannot find package')) {
        logger.warn('--------xrk依赖缺失--------');
        logger.warn(`XRK 缺少依赖 ${i}`);
        logger.warn(`如需使用请运行：${logger.red(`pnpm add ${i} -w`)}`);
        logger.warn('---------------------------');
      } else {
        logger.error(`向日葵载入依赖错误：${logger.red(i)}`);
        logger.error(decodeURI(error.stack));
      }
    }
  }
}

checkDependencies();

// ========== 【1. 检查并生成配置文件】 ==========
const _path = process.cwd();
const configDir = path.join(_path, 'data', 'xrkconfig');
const configFile = path.join(configDir, 'config.yaml');

// 默认配置
const defaultConfig = {
  peopleai: false,
  time_groupss: [],
  news_groupss: [],
  news_pushtime: 8,
  screen_shot_quality: 1.5,
  help_priority: 500,
  coremaster: 12345678,
  emoji_filename: '孤独摇滚',
  signchecker: false,
  screen_shot_http: false,
  thumwhiteList: [],
  sharing: true,
  selfcontrol: true,
  // 更新后的AI配置
  ai: {
    apiKey: "YOUR_AI_API_KEY_HERE",
    baseUrl: "https://api.gptgod.online/v1",
    fileUploadUrl: "https://api.gptgod.online/v1/file",
    chatModel: "deepseek-ai/DeepSeek-V3",
    visionModel: "OpenGPT-4o",
    max_tokens: 6000,
    temperature: 0.8,
    top_p: 0.9,
    presence_penalty: 0.6,
    frequency_penalty: 0.6,
    // 新增配置项
    triggerPrefix: "",
    historyLimit: 10,
    defaultPersona: "assistant",
    whitelist: {
      groups: [],
      users: []
    },
    globalWhitelist: [],
    globalAIChance: 0.05,
    globalAICooldown: 300
  },
  // 新的戳一戳配置
  poke: {
    enabled: true,  // 总开关
    priority: -5000,  // 优先级
    
    // 模块开关
    modules: {
      basic: true,          // 基础回复
      mood: true,           // 心情系统
      intimacy: true,       // 亲密度系统
      achievement: true,    // 成就系统
      special: true,        // 特殊效果
      punishment: true,     // 惩罚系统
      pokeback: true,       // 反戳系统
      image: true,          // 图片发送
      voice: true,          // 语音发送
      master: true          // 主人保护
    },
    
    // 功能配置
    pokeback_enabled: true,  // 是否启用机器人戳回功能（无法戳时关闭）
    image_chance: 0.3,       // 发送图片概率
    voice_chance: 0.2,       // 发送语音概率
    master_image: true,      // 戳主人时是否发送图片
    master_punishment: true, // 是否惩罚戳主人的人
    
    // 冷却时间（毫秒）
    cooldowns: {
      interaction: 30000,    // 互动冷却
      special_effect: 180000, // 特效冷却
      punishment: 60000      // 惩罚冷却
    },
    
    // 概率设置
    chances: {
      mood_change: 0.2,      // 心情变化概率
      special_trigger: 0.15, // 特效触发概率
      punishment: 0.3        // 惩罚概率
    }
  }
};

// 改进后的合并配置函数
function mergeConfigs(defaultConfig, userConfig) {
  const result = {};
  for (const key in defaultConfig) {
    if (defaultConfig.hasOwnProperty(key)) {
      const defaultValue = defaultConfig[key];
      const userValue = userConfig[key];
      if (typeof defaultValue === 'object' && !Array.isArray(defaultValue)) {
        if (userValue && typeof userValue === 'object' && !Array.isArray(userValue)) {
          result[key] = mergeConfigs(defaultValue, userValue);
        } else {
          result[key] = defaultValue;
        }
      } else {
        if (userConfig.hasOwnProperty(key)) {
          if (typeof userValue === typeof defaultValue) {
            result[key] = userValue;
          } else {
            console.warn(chalk.yellow(`[Config] ${key} 类型错误，应为 ${typeof defaultValue}，使用默认值`));
            result[key] = defaultValue;
          }
        } else {
          result[key] = defaultValue;
        }
      }
    }
  }
  return result;
}

// 创建配置目录（如果不存在）
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

// 读取或初始化用户配置
let userConfig = {};
if (fs.existsSync(configFile)) {
  try {
    const content = fs.readFileSync(configFile, 'utf-8');
    userConfig = yaml.parse(content);
    if (!userConfig || typeof userConfig !== 'object') {
      userConfig = {};
    }
  } catch (err) {
    console.error(chalk.red('[Config] 解析配置文件出错:'), err);
    userConfig = {};
  }
} else {
  fs.writeFileSync(
    configFile,
    yaml.stringify(defaultConfig, { indent: 2 }),
    'utf-8'
  );
  userConfig = defaultConfig;
}

// 合并配置
const finalConfig = mergeConfigs(defaultConfig, userConfig);

// 写入更新后的配置文件
fs.writeFileSync(
  configFile,
  yaml.stringify(finalConfig, { indent: 2 }),
  'utf-8'
);

// 清理凭证文件
const CREDENTIALS_PATH = path.join(_path, 'data', 'xrkconfig', '.xrk', 'credentials.json');
const LAST_CLEAN_PATH = path.join(_path, 'data', 'xrkconfig', '.xrk', 'last_clean.txt');

function getTodayString() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function cleanCredentialsIfNeeded() {
  try {
    let lastCleanDate = '';
    try {
      lastCleanDate = fs.readFileSync(LAST_CLEAN_PATH, 'utf8');
    } catch (e) {}
    const today = getTodayString();
    if (lastCleanDate !== today) {
      if (fs.existsSync(CREDENTIALS_PATH)) {
        fs.unlinkSync(CREDENTIALS_PATH);
      }
      const dir = path.dirname(LAST_CLEAN_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(LAST_CLEAN_PATH, today);
    }
  } catch (err) {
    logger.error(chalk.red('[Credentials] 清理文件出错:'), err);
  }
}

cleanCredentialsIfNeeded();

// 初始化日志
logger.info(chalk.cyan('----------(≧▽≦)/---------'));
logger.info(chalk.yellow('向日葵插件初始化开始~'));
logger.info(chalk.yellow('现在只为葵崽服务了呢~'));
logger.info(chalk.yellow('发送向日葵帮助解锁功能哦~'));
logger.info(chalk.magenta('-------------------------'));

// 加载插件
const files = fs
  .readdirSync('./plugins/XRK/apps')
  .filter((file) => file.endsWith('.js'));
let ret = [];
files.forEach((file) => {
  ret.push(import(`./apps/${file}`));
});

ret = await Promise.allSettled(ret);

let apps = {};
for (let i in files) {
  let name = files[i].replace('.js', '');
  if (ret[i].status !== 'fulfilled') {
    logger.error(`载入插件错误：${logger.red(name)}`);
    logger.error(ret[i].reason);
    continue;
  }
  apps[name] = ret[i].value[Object.keys(ret[i].value)[0]];
}

// 导出配置和应用
export { apps, finalConfig as config };