import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import fetch from 'node-fetch';
import { exec } from 'node:child_process';
import moment from 'moment';
import axios from 'axios';
import crypto from 'crypto';
import zlib from 'zlib';
import querystring from 'querystring';
import url from 'url';
import stream from 'stream';
import os from 'os';
import events from 'events';
import readline from 'readline';
import common from '../../../lib/common/common.js';
import cfg from '../../../lib/config/config.js';
import { 制作聊天记录 } from '../../../lib/util.js';
import util from 'util';

const ROOT_PATH = process.cwd();

let configFile = path.join(ROOT_PATH, 'config', 'cmd', 'tools.yaml');
let config;
let terminal;
let history;
let inspector

/**
 * 工具配置管理类
 */
class ToolsConfig {
  constructor(configPath) {
    this.configPath = configPath;
    this.config = {};
    this.loadConfig();
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        this.config = YAML.parse(fs.readFileSync(this.configPath, 'utf8'));
      } else {
        this.config = {
          permission: 'master',
          blacklist: true,
          ban: ['rm -rf', 'sudo', 'shutdown', 'reboot'],
          shell: true,
          timeout: 300000,
          maxHistory: 100,
          updateInterval: 3000,
          maxOutputLength: 5000,
          maxObjectDepth: 4,
          circularDetection: true,
          printMode: 'full',
          saveChunkedOutput: true,
        };
        this.saveConfig();
      }
    } catch (error) {
      logger.error(`[终端工具] 配置文件加载失败: ${error.message}`);
    }
  }

  saveConfig() {
    try {
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, YAML.stringify(this.config), 'utf8');
    } catch (error) {
      logger.error(`[终端工具] 配置文件保存失败: ${error.message}`);
    }
  }

  get(key, defaultValue) {
    return key in this.config ? this.config[key] : defaultValue;
  }

  set(key, value) {
    this.config[key] = value;
    this.saveConfig();
  }
}

/**
 * 终端命令处理类
 */
class TerminalHandler {
  constructor() {
    if (process.platform === 'win32') {
      this.formatPrompt = (cmd) =>
        `powershell -EncodedCommand ${Buffer.from(
          `$ProgressPreference="SilentlyContinue";[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;${cmd}`,
          'utf-16le'
        ).toString('base64')}`;
      this.formatOutput = (cmd, data) => data.replace(/\r\n/g, '\n').trim();
    } else {
      this.formatPrompt = (cmd) => cmd;
      this.formatOutput = (cmd, data) => data.trim();
    }

    // 添加输出文件路径
    this.outputDir = path.join(ROOT_PATH, 'data', 'terminal_output');
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  isLongRunningCommand(cmd) {
    const longRunningPatterns = [
      /\bgit\s+clone\b/i,
      /\bgit\s+pull\b/i,        // 添加git pull
      /\bgit\s+push\b/i,        // 添加git push
      /\bgit\s+fetch\b/i,       // 添加git fetch
      /\bgit\s+log\b/i,         // 添加git log
      /\bnpm\s+(install|update|ci|i)\b/i,
      /\byarn\s+(install|add)\b/i,
      /\bpnpm\s+(install|add)\b/i,
      /\bcurl\s+.*\s+-o\b/i,
      /\bwget\b/i,
      /\bpip\s+(install|download)\b/i,
      /\bapt\s+(update|upgrade|install)\b/i,
      /\byum\s+install\b/i,
      /\bcomposer\s+install\b/i,
      /\bmvn\s+install\b/i,
      /\bdownload\b/i,
      /\binstall\b/i,
      /\bdocker\s+(pull|build|compose)\b/i,
      /\bfind\s+.*\s+-exec\b/i,  // 添加find命令
      /\bgrep\s+-r\b/i,          // 添加grep递归搜索
      /\bscp\b/i,                // 添加scp传输
      /\brsync\b/i,              // 添加rsync
      /\bcp\s+-r\b/i,            // 添加大文件复制
      /\bmv\s+-r\b/i,            // 添加大文件移动
    ];
    return longRunningPatterns.some((pattern) => pattern.test(cmd));
  }

  // 检测是否包含git命令
  isGitCommand(cmd) {
    return /\bgit\b/.test(cmd);
  }

  // 保存长输出到文件
  saveOutputToFile(cmd, output) {
    try {
      const timestamp = moment().format('YYYYMMDD_HHmmss');
      const sanitizedCmd = cmd.replace(/[^a-z0-9]/gi, '_').substring(0, 20);
      const filename = `${timestamp}_${sanitizedCmd}.log`;
      const filepath = path.join(this.outputDir, filename);

      fs.writeFileSync(filepath, output, 'utf8');
      return filepath;
    } catch (error) {
      logger.error(`[终端工具] 保存输出到文件失败: ${error.message}`);
      return null;
    }
  }

  async execute(e, cmd, options, timeout = 300000) {
    const isLongRunning = this.isLongRunningCommand(cmd);
    const isGitCmd = this.isGitCommand(cmd);
    const updateInterval = config.get('updateInterval', 3000);
    const maxOutputLength = config.get('maxOutputLength', 5000);
    const saveChunkedOutput = config.get('saveChunkedOutput', true);

    // 特殊处理git命令，增加输出限制
    if (isGitCmd) {
      if (cmd.includes('git log')) {
        // 限制git log的输出数量
        if (!cmd.includes('-n') && !cmd.includes('--max-count')) {
          cmd = cmd.replace(/git log/, 'git log -n 30');
        }
      }

      // 确保git命令输出不截断
      if (cmd.includes('git status') || cmd.includes('git diff')) {
        cmd = cmd.replace(/git /, 'git -c color.ui=always ');
      }
    }

    if (isLongRunning) {
      await e.reply(
        `⏳ 开始执行命令: ${cmd}\n该命令可能需要较长时间，将实时更新执行进度...`
      );
    }

    return new Promise(async (resolve) => {
      const startTime = Date.now();
      let chunkedOutput = [];  // 用于存储分块输出
      const command = exec(this.formatPrompt(cmd), {
        ...options,
        maxBuffer: 10 * 1024 * 1024  // 增大maxBuffer到10MB
      });

      let stdout = '';
      let stderr = '';
      let lastUpdateTime = Date.now();
      let msgId = null;
      const updateOutput = async () => {
        if (Date.now() - lastUpdateTime < updateInterval) return;
        lastUpdateTime = Date.now();

        let currentOutput = stdout || stderr;
        if (saveChunkedOutput && currentOutput.trim()) {
          chunkedOutput.push(currentOutput.trim());
        }

        if (currentOutput.length > maxOutputLength) {
          currentOutput =
            '...(输出太长，仅显示最近部分)\n' +
            currentOutput.slice(-maxOutputLength);
        }

        if (currentOutput.trim()) {
          try {
            if (msgId) {
              try {
                (e.isGroup ? e.group : e.friend)?.recallMsg(msgId);
              } catch (error) {
                logger.debug(`[终端工具] 撤回消息失败: ${error.message}`);
              }
            }
            const msg = await 制作聊天记录(e, currentOutput.trim(), '⏳ 命令执行进行中', `${cmd} | 已执行: ${((Date.now() - startTime) / 1000).toFixed(1)}秒`);

            if (msg && msg.message_id) {
              msgId = msg.message_id;
            }
          } catch (error) {
            logger.error(`[终端工具] 更新消息错误: ${error.message}`);
            try {
              const msg = await e.reply(`⏳ 命令执行进行中...\n执行时间: ${((Date.now() - startTime) / 1000).toFixed(1)}秒`, true);
              if (msg && msg.message_id) {
                msgId = msg.message_id;
              }
            } catch (innerError) {
              logger.error(`[终端工具] 发送进度消息失败: ${innerError.message}`);
            }
          }
        }
      };

      command.stdout.on('data', (data) => {
        stdout += data.toString();
        if (isLongRunning) updateOutput();
      });

      command.stderr.on('data', (data) => {
        stderr += data.toString();
        if (isLongRunning) updateOutput();
      });

      const timer = setTimeout(() => {
        command.kill();
        resolve({
          success: false,
          message: `命令执行超时（${timeout / 1000}秒）`,
          code: 124,
          stdout,
          stderr,
          startTime,
          endTime: Date.now(),
        });
      }, timeout);

      command.on('close', async (code) => {
        clearTimeout(timer);
        logger.debug(`命令 "${cmd}" 返回代码: ${code}`);

        if (isLongRunning && msgId) {
          try {
            (e.isGroup ? e.group : e.friend)?.recallMsg(msgId);
          } catch (error) {
            logger.debug(`[终端工具] 无法撤回消息: ${error.message}`);
          }
        }

        let finalOutput = stdout || stderr;
        if (code !== 0 && stderr) {
          finalOutput = stderr;
        }

        // 合并所有分块输出
        if (saveChunkedOutput && chunkedOutput.length > 0) {
          const completeOutput = chunkedOutput.join('\n\n');
          // 如果输出超长，保存到文件
          if (completeOutput.length > maxOutputLength * 2) {
            const outputFile = this.saveOutputToFile(cmd, completeOutput);
            if (outputFile) {
              finalOutput += `\n\n[完整输出太长，已保存到文件: ${outputFile}]`;
            }
          }
        }

        // 处理最终输出
        let formattedOutput = this.formatOutput(cmd, finalOutput || (code === 0 ? '任务已完成，无返回' : `执行失败，返回代码: ${code}`));

        // 截断过长输出
        if (formattedOutput.length > maxOutputLength) {
          // 对于git命令，可能需要特殊处理
          if (isGitCmd && formattedOutput.length > maxOutputLength * 1.5) {
            const outputFile = this.saveOutputToFile(cmd, formattedOutput);
            if (outputFile) {
              formattedOutput = formattedOutput.slice(0, maxOutputLength) +
                `\n\n... 输出太长 (${formattedOutput.length} 字符)，完整输出已保存到: ${outputFile}`;
            } else {
              formattedOutput = formattedOutput.slice(0, maxOutputLength) +
                `\n\n... 输出被截断 (共 ${formattedOutput.length} 字符)`;
            }
          } else {
            formattedOutput = formattedOutput.slice(0, maxOutputLength) +
              `\n\n... 输出被截断 (共 ${formattedOutput.length} 字符)`;
          }
        }

        resolve({
          success: code === 0,
          message: formattedOutput,
          code: code,
          stdout,
          stderr,
          startTime,
          endTime: Date.now(),
        });
      });
    });
  }
}

/**
 * 命令历史记录管理类
 */
class CommandHistory {
  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.history = [];
    this.historyFile = path.join(ROOT_PATH, 'data', 'tools_history.json');
    this.loadHistory();
  }

  loadHistory() {
    try {
      if (fs.existsSync(this.historyFile)) {
        this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
      }
    } catch (error) {
      logger.error(`[终端工具] 历史记录加载失败: ${error.message}`);
      this.history = [];
    }
  }

  saveHistory() {
    try {
      const dir = path.dirname(this.historyFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.historyFile, JSON.stringify(this.history), 'utf8');
    } catch (error) {
      logger.error(`[终端工具] 历史记录保存失败: ${error.message}`);
    }
  }

  add(command, type, code) {
    this.history.unshift({
      command,
      type,
      timestamp: Date.now(),
      code,
    });
    if (this.history.length > this.maxSize) {
      this.history = this.history.slice(0, this.maxSize);
    }
    this.saveHistory();
  }

  get(limit = 10, type = null) {
    if (type) {
      return this.history.filter((item) => item.type === type).slice(0, limit);
    }
    return this.history.slice(0, limit);
  }

  clear() {
    this.history = [];
    this.saveHistory();
    return true;
  }
}

/**
 * 对象检查工具
 */
class ObjectInspector {
  constructor(options = {}) {
    this.options = {
      maxDepth: options.maxDepth || 4,             // 最大嵌套深度
      circularDetection: options.circularDetection !== false, // 检测循环引用
      showPrototype: options.showPrototype !== false,         // 显示原型链属性
      showGettersSetters: options.showGettersSetters !== false, // 显示 getter/setter
      showFunctions: options.showFunctions !== false,         // 显示函数
      maxArrayItems: options.maxArrayItems || 30,  // 数组最大显示项数
      maxStringLength: options.maxStringLength || 200, // 字符串最大长度
      maxPropertiesPerObject: options.maxPropertiesPerObject || 100, // 对象最大属性数
    };
  }

  /** 检查对象并返回结构化信息 */
  inspect(obj, name = 'Object') {
    // 处理 null 或 undefined
    if (obj === null || obj === undefined) {
      return {
        name,
        type: obj === null ? 'null' : 'undefined',
        value: String(obj),
        properties: [],
        methods: [],
      };
    }

    // 处理基本数据类型
    if (typeof obj !== 'object' && typeof obj !== 'function') {
      return {
        name,
        type: typeof obj,
        value: this.formatValue(obj),
        properties: [],
        methods: [],
      };
    }

    const result = {
      name,
      type: this.getType(obj),
      properties: [],
      methods: [],
    };

    try {
      const seen = new WeakMap(); // 用于检测循环引用
      this.collectPropertiesAndMethods(obj, result, seen, 0);
      result.propertyCount = result.properties.length;
      result.methodCount = result.methods.length;

      // 属性排序：按来源和名称排序
      result.properties.sort((a, b) => {
        const sourceOrder = { 'own': 0, 'array': 1, 'proto': 2, 'circular': 3 };
        if (sourceOrder[a.from] !== sourceOrder[b.from]) {
          return sourceOrder[a.from] - sourceOrder[b.from];
        }
        return a.name.localeCompare(b.name);
      });

      // 方法排序
      result.methods.sort((a, b) => {
        const sourceOrder = { 'own': 0, 'proto': 1 };
        if (sourceOrder[a.from] !== sourceOrder[b.from]) {
          return sourceOrder[a.from] - sourceOrder[b.from];
        }
        return a.name.localeCompare(b.name);
      });

      return result;
    } catch (error) {
      logger.error(`[终端工具] 对象检查错误: ${error.stack || error.message}`);
      return {
        name,
        type: this.getType(obj),
        error: `检查错误: ${error.message}`,
        properties: [],
        methods: [],
      };
    }
  }

  /** 获取对象类型 */
  getType(obj) {
    if (obj === null) return 'null';
    if (obj === undefined) return 'undefined';

    // 检测特定类型的对象
    if (obj._events && obj._eventsCount && typeof obj.emit === 'function') return 'EventEmitter';
    if (obj.group && obj.user_id && obj.message) return 'MessageEvent';
    if (obj.user_id && obj.nickname && !obj.message) return 'User';
    if (obj.group_id && obj.group_name) return 'Group';
    if (obj.sendMsg && obj.pickUser && obj.pickGroup) return 'Bot';

    // 内置类型检测
    if (Array.isArray(obj)) return 'Array';
    if (obj instanceof Date) return 'Date';
    if (obj instanceof RegExp) return 'RegExp';
    if (obj instanceof Error) return obj.constructor.name;
    if (obj instanceof Map) return 'Map';
    if (obj instanceof Set) return 'Set';
    if (obj instanceof WeakMap) return 'WeakMap';
    if (obj instanceof WeakSet) return 'WeakSet';
    if (obj instanceof Promise) return 'Promise';
    if (Buffer.isBuffer(obj)) return 'Buffer';
    if (obj instanceof stream.Readable) return 'ReadableStream';
    if (obj instanceof stream.Writable) return 'WritableStream';

    // 函数类型
    if (typeof obj === 'function') {
      return obj.constructor.name === 'Function' ? 'Function' : obj.constructor.name;
    }

    // 普通对象
    if (typeof obj === 'object') {
      if (!obj.constructor) return 'Object';
      return obj.constructor.name;
    }

    return typeof obj;
  }

  /** 格式化值 */
  formatValue(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';

    if (typeof value === 'object' || typeof value === 'function') {
      if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        const items = value.slice(0, this.options.maxArrayItems).map((item) => {
          return typeof item === 'object' && item !== null ? this.getType(item) : this.formatValue(item);
        });
        if (value.length > this.options.maxArrayItems) items.push(`...共${value.length}项`);
        return `[${items.join(', ')}]`;
      }

      if (value instanceof Date) return value.toISOString();
      if (value instanceof RegExp) return value.toString();
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      if (value instanceof Map) {
        const entries = Array.from(value.entries()).slice(0, 5);
        const formatted = entries.map(([k, v]) =>
          `${this.formatValue(k)} => ${typeof v === 'object' && v !== null ? this.getType(v) : this.formatValue(v)}`
        ).join(', ');
        return `Map(${value.size})${entries.length ? ' { ' + formatted + (value.size > 5 ? ', ... }' : ' }') : ''}`;
      }
      if (value instanceof Set) {
        const items = Array.from(value).slice(0, 5).map((item) =>
          typeof item === 'object' && item !== null ? this.getType(item) : this.formatValue(item)
        ).join(', ');
        return `Set(${value.size})${items.length ? ' { ' + formatted + (value.size > 5 ? ', ... }' : ' }') : ''}`;
      }
      if (value instanceof WeakMap) return 'WeakMap{}';
      if (value instanceof WeakSet) return 'WeakSet{}';
      if (value instanceof Promise) return 'Promise';
      if (Buffer.isBuffer(value)) {
        return `Buffer(${value.length}) [${value.slice(0, 3).toString('hex').match(/../g).join(' ')}${value.length > 3 ? '...' : ''}]`;
      }
      if (value instanceof stream.Readable) return 'ReadableStream';
      if (value instanceof stream.Writable) return 'WritableStream';

      if (typeof value === 'function') {
        let funcStr = value.toString();
        if (funcStr.includes('[native code]')) {
          return value.name ? `function ${value.name}() [native]` : 'function() [native]';
        }
        if (funcStr.length > 200) funcStr = funcStr.substring(0, 197) + '...';
        return funcStr;
      }

      // 特殊对象预览
      if (value._events && value._eventsCount) return `EventEmitter (${Object.keys(value._events).length} events)`;
      if (value.group && value.user_id && value.message) return `MessageEvent (from: ${value.sender?.nickname || value.user_id})`;
      if (value.user_id && value.nickname && !value.message) return `User (${value.nickname}, ${value.user_id})`;
      if (value.group_id && value.group_name) return `Group (${value.group_name}, ${value.group_id})`;
      if (value.sendMsg && value.pickUser) return `Bot (${value.nickname || 'Unknown'})`;

      return `[${this.getType(value)}]`;
    }

    // 字符串处理
    if (typeof value === 'string') {
      if (value.length > this.options.maxStringLength) {
        return `"${value.substring(0, this.options.maxStringLength - 3)}..."`;
      }
      return `"${value.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
    }

    return String(value);
  }

  /** 收集属性和方法 */
  collectPropertiesAndMethods(obj, result, seen, depth) {
    if (depth >= this.options.maxDepth) {
      result.properties.push({
        name: '(达到最大深度)',
        type: 'info',
        value: `最大深度: ${this.options.maxDepth}`,
        from: 'info',
      });
      return;
    }

    // 检测循环引用
    if (this.options.circularDetection && typeof obj === 'object' && obj !== null) {
      if (seen.has(obj)) {
        result.properties.push({
          name: '(循环引用)',
          type: 'circular',
          value: '(循环引用到上层对象)',
          from: 'circular',
        });
        return;
      }
      seen.set(obj, true);
    }

    try {
      // 处理数组
      if (Array.isArray(obj)) {
        result.properties.push({
          name: 'length',
          type: 'number',
          value: String(obj.length),
          from: 'own',
        });

        const maxItems = Math.min(obj.length, this.options.maxArrayItems);
        for (let i = 0; i < maxItems; i++) {
          try {
            const item = obj[i];
            const itemType = typeof item;
            result.properties.push({
              name: String(i),
              type: itemType === 'object' && item !== null ? this.getType(item) : itemType,
              value: this.formatValue(item),
              from: 'array',
              isArrayItem: true,
            });
          } catch (itemError) {
            result.properties.push({
              name: String(i),
              type: 'error',
              value: `[无法访问: ${itemError.message}]`,
              from: 'array',
              isArrayItem: true,
            });
          }
        }
        if (obj.length > maxItems) {
          result.properties.push({
            name: `...剩余${obj.length - maxItems}项`,
            type: 'info',
            value: '(已省略)',
            from: 'array',
            isArrayItem: true,
          });
        }
      }

      // 处理 Map
      if (obj instanceof Map) {
        result.properties.push({
          name: 'size',
          type: 'number',
          value: String(obj.size),
          from: 'own',
        });

        let index = 0;
        for (const [key, value] of obj.entries()) {
          if (index >= this.options.maxArrayItems) {
            result.properties.push({
              name: `...剩余${obj.size - this.options.maxArrayItems}项`,
              type: 'info',
              value: '(已省略)',
              from: 'own',
            });
            break;
          }
          const keyStr = typeof key === 'object' && key !== null ? `[${this.getType(key)}]` : this.formatValue(key);
          result.properties.push({
            name: `[key: ${keyStr}]`,
            type: typeof value,
            value: this.formatValue(value),
            from: 'own',
          });
          index++;
        }
      }

      // 处理 Set
      if (obj instanceof Set) {
        result.properties.push({
          name: 'size',
          type: 'number',
          value: String(obj.size),
          from: 'own',
        });

        let index = 0;
        for (const value of obj) {
          if (index >= this.options.maxArrayItems) {
            result.properties.push({
              name: `...剩余${obj.size - this.options.maxArrayItems}项`,
              type: 'info',
              value: '(已省略)',
              from: 'own',
            });
            break;
          }
          result.properties.push({
            name: `[${index}]`,
            type: typeof value,
            value: this.formatValue(value),
            from: 'own',
          });
          index++;
        }
      }

      // 收集自有属性
      let ownProps = [];
      try {
        ownProps = Object.getOwnPropertyNames(obj);
      } catch (error) {
        result.properties.push({
          name: '(错误)',
          type: 'error',
          value: `获取属性名失败: ${error.message}`,
          from: 'error',
        });
      }

      if (ownProps.length > this.options.maxPropertiesPerObject) {
        ownProps = ownProps.slice(0, this.options.maxPropertiesPerObject);
        result.properties.push({
          name: '(已限制)',
          type: 'info',
          value: `属性数量超过限制，仅显示 ${this.options.maxPropertiesPerObject}/${Object.getOwnPropertyNames(obj).length} 项`,
          from: 'info',
        });
      }

      for (const prop of ownProps) {
        try {
          if (
            Array.isArray(obj) &&
            ((!isNaN(parseInt(prop)) && parseInt(prop) < this.options.maxArrayItems) || prop === 'length')
          ) continue;

          if (prop.startsWith('Symbol(') || prop === 'constructor' || prop === '_events' || prop === '_eventsCount') continue;

          const descriptor = Object.getOwnPropertyDescriptor(obj, prop);
          if (descriptor && (descriptor.get || descriptor.set)) {
            if (this.options.showGettersSetters) {
              let accessorValue = '无法访问';
              if (descriptor.get) {
                try {
                  const value = obj[prop];
                  accessorValue = typeof value === 'object' && value !== null ? `[${this.getType(value)}]` : this.formatValue(value);
                } catch (getterError) {
                  accessorValue = `[访问器错误: ${getterError.message}]`;
                }
              }
              result.properties.push({
                name: prop,
                type: descriptor.get && descriptor.set ? 'accessor' : descriptor.get ? 'getter' : 'setter',
                value: accessorValue,
                from: 'own',
              });
            }
            continue;
          }

          let value;
          try {
            value = obj[prop];
          } catch (accessError) {
            result.properties.push({
              name: prop,
              type: 'error',
              value: `[无法访问: ${accessError.message}]`,
              from: 'own',
            });
            continue;
          }

          if (typeof value === 'function') {
            if (this.options.showFunctions) {
              result.methods.push({
                name: prop,
                params: this.extractFunctionParams(value),
                from: 'own',
                returnType: '未知',
              });
            }
          } else {
            result.properties.push({
              name: prop,
              type: typeof value,
              value: this.formatValue(value),
              from: 'own',
            });
          }
        } catch (propError) {
          result.properties.push({
            name: prop,
            type: 'error',
            value: `[无法访问: ${propError.message}]`,
            from: 'own',
          });
        }
      }

      // 处理原型链
      if (this.options.showPrototype) {
        try {
          const proto = Object.getPrototypeOf(obj);
          if (proto && proto !== Object.prototype && proto !== Function.prototype) {
            let protoProps = [];
            try {
              protoProps = Object.getOwnPropertyNames(proto);
            } catch (protoPropsError) {
              result.properties.push({
                name: '(原型错误)',
                type: 'error',
                value: `获取原型属性失败: ${protoPropsError.message}`,
                from: 'proto',
              });
            }

            for (const prop of protoProps) {
              if (prop === 'constructor' || prop.startsWith('__')) continue;

              try {
                const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
                if (descriptor && (descriptor.get || descriptor.set)) {
                  if (this.options.showGettersSetters) {
                    result.properties.push({
                      name: prop,
                      type: descriptor.get && descriptor.set ? 'accessor' : descriptor.get ? 'getter' : 'setter',
                      value: '[访问器属性]',
                      from: 'proto',
                    });
                  }
                  continue;
                }

                const value = proto[prop];
                if (typeof value === 'function') {
                  if (this.options.showFunctions && !result.methods.some((m) => m.name === prop)) {
                    result.methods.push({
                      name: prop,
                      params: this.extractFunctionParams(value),
                      from: 'proto',
                      returnType: '未知',
                    });
                  }
                } else if (!result.properties.some((p) => p.name === prop)) {
                  result.properties.push({
                    name: prop,
                    type: typeof value,
                    value: this.formatValue(value),
                    from: 'proto',
                  });
                }
              } catch (protoError) {
                // 跳过原型属性错误
              }
            }
          }
        } catch (protoAccessError) {
          result.properties.push({
            name: '(原型错误)',
            type: 'error',
            value: `获取原型链失败: ${protoAccessError.message}`,
            from: 'proto',
          });
        }
      }
    } catch (error) {
      logger.error(`[终端工具] 收集属性方法错误: ${error.message}`);
      result.properties.push({
        name: '(错误)',
        type: 'error',
        value: `收集属性失败: ${error.message}`,
        from: 'error',
      });
    }
  }

  /** 提取函数参数 */
  extractFunctionParams(func) {
    try {
      const funcStr = func.toString();
      if (funcStr.includes('[native code]')) {
        const name = func.name || '';
        const commonPatterns = {
          forEach: 'callback, thisArg',
          map: 'callback, thisArg',
          filter: 'callback, thisArg',
          find: 'callback, thisArg',
          some: 'callback, thisArg',
          every: 'callback, thisArg',
          reduce: 'callback, initialValue',
          push: '...items',
          pop: '',
          shift: '',
          unshift: '...items',
          sort: 'compareFn',
          splice: 'start, deleteCount, ...items',
          slice: 'start, end',
          concat: '...arrays',
          join: 'separator',
          toString: '',
          valueOf: '',
          indexOf: 'searchElement, fromIndex',
          lastIndexOf: 'searchElement, fromIndex',
          includes: 'searchElement, fromIndex',
          send: 'message',
          reply: 'message, quote',
          sendMsg: 'message, target',
          exec: 'command, options',
          on: 'event, listener',
          emit: 'event, ...args',
          once: 'event, listener',
        };
        return commonPatterns[name] || '';
      }

      const arrowMatch = funcStr.match(/^\s*(?:async\s*)?(?:\(([^)]*)\)|(\w+))\s*=>\s*/);
      if (arrowMatch) return arrowMatch[1] || arrowMatch[2] || '';
      const paramsMatch = funcStr.match(/^\s*(?:async\s*)?function(?:\s+\w+)?\s*\(([^)]*)\)/);
      return paramsMatch ? paramsMatch[1] : '';
    } catch (error) {
      return '(无法解析参数)';
    }
  }

  /** 格式化输出结果 */
  formatResult(result) {
    if (result.error) return `错误: ${result.error}`;

    let output = `【${result.name} 对象详情】\n`;
    output += `类型: ${result.type}\n`;
    if (result.value !== undefined) output += `值: ${result.value}\n`;
    output += `共 ${result.methodCount || 0} 个方法, ${result.propertyCount || 0} 个属性\n\n`;

    // 属性分类显示
    if (result.properties && result.properties.length > 0) {
      const ownProps = result.properties.filter(p => p.from === 'own' && !p.isArrayItem);
      const arrayProps = result.properties.filter(p => p.isArrayItem);
      const protoProps = result.properties.filter(p => p.from === 'proto');
      const otherProps = result.properties.filter(p => !['own', 'proto'].includes(p.from) && !p.isArrayItem);

      if (arrayProps.length > 0) {
        output += `—— 数组项 (${arrayProps.length}) ——\n`;
        for (const prop of arrayProps) {
          output += `• ${prop.name}: ${prop.value} [${prop.type}]\n`;
        }
        output += '\n';
      }

      if (ownProps.length > 0) {
        output += `—— 自有属性 (${ownProps.length}) ——\n`;
        for (const prop of ownProps) {
          output += `• ${prop.name}: ${prop.value} [${prop.type}]\n`;
        }
        output += '\n';
      }

      if (protoProps.length > 0) {
        output += `—— 继承属性 (${protoProps.length}) ——\n`;
        for (const prop of protoProps) {
          output += `• ${prop.name}: ${prop.value} [${prop.type}]\n`;
        }
        output += '\n';
      }

      if (otherProps.length > 0) {
        output += `—— 其他属性 (${otherProps.length}) ——\n`;
        for (const prop of otherProps) {
          output += `• ${prop.name}: ${prop.value} [${prop.type}] (${prop.from})\n`;
        }
        output += '\n';
      }
    }

    // 方法分类显示
    if (result.methods && result.methods.length > 0) {
      const ownMethods = result.methods.filter(m => m.from === 'own');
      if (ownMethods.length > 0) {
        output += `—— 自有方法 (${ownMethods.length}) ——\n`;
        for (const method of ownMethods) {
          const params = method.params ? `(${method.params})` : '()';
          output += `• ${method.name}${params}\n`;
        }
        output += '\n';
      }

      const protoMethods = result.methods.filter(m => m.from === 'proto');
      if (protoMethods.length > 0) {
        output += `—— 继承方法 (${protoMethods.length}) ——\n`;
        for (const method of protoMethods) {
          const params = method.params ? `(${method.params})` : '()';
          output += `• ${method.name}${params}\n`;
        }
      }
    }

    return output;
  }
}

/**
 * 增强型终端工具插件
 */
config = new ToolsConfig(configFile);
terminal = new TerminalHandler();
history = new CommandHistory(config.get('maxHistory', 100));
inspector = new ObjectInspector({
  maxDepth: config.get('maxObjectDepth', 4),
  circularDetection: config.get('circularDetection', true),
  showPrototype: true,
  showGettersSetters: true,
  showFunctions: true,
  maxArrayItems: 30,
  maxStringLength: 200,
});

export class EnhancedTools extends plugin {
  constructor() {
    super({
      name: '终端工具',
      dsc: '执行终端命令和JavaScript代码',
      event: 'message',
      priority: 600,
      rule: [
        // 项目目录执行终端命令
        {
          reg: /^rx\s*([\s\S]*?)$/i,
          fnc: 'runTerminalXRK',
          permission: config.get('permission'),
        },
        // 用户主目录执行终端命令
        {
          reg: /^rh\s*([\s\S]*?)$/i,
          fnc: 'runTerminalhome',
          permission: config.get('permission'),
        },
        // 检查对象
        {
          reg: /^roj\s*([\s\S]*?)$/i,
          fnc: 'accessObject',
          permission: config.get('permission'),
        },
        // 执行方法
        {
          reg: /^rj\s*([\s\S]*?)$/i,
          fnc: 'runMethod',
          permission: config.get('permission'),
        },
        // 显示对应代码执行记录
        {
          reg: /^rrl\s*(\w*)\s*(\d*)\s*$/i,
          fnc: 'showHistory',
          permission: config.get('permission'),
        },
        // 配置工具
        {
          reg: /^rc\s*([\s\S]*?)$/i,
          fnc: 'configTool',
          permission: config.get('permission'),
        },
      ],
    });
  }

  /** 执行终端命令 */
  async runTerminalXRK(e) {
    let msg = e.msg.replace(/^rx\s*/i, '').trim();
    if (!msg) return false;

    if (config.get('blacklist', true)) {
      const banList = config.get('ban', []);
      for (const bannedCmd of banList) {
        if (msg.includes(bannedCmd)) {
          await e.reply(`❌ 命令 "${msg}" 包含禁用关键词 "${bannedCmd}"`, true);
          logger.debug(`已拦截黑名单命令: ${msg}`);
          return true;
        }
      }
    }

    try {
      const options = {
        cwd: ROOT_PATH,
        shell: config.get('shell', true),
        stdio: 'pipe',
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, FORCE_COLOR: '1' },
      };

      const timeout = config.get('timeout', 300000);
      const result = await terminal.execute(e, msg, options, timeout);

      history.add(msg, 'terminal', result.code);

      if (result.message) {
        const icon = result.code === 0 ? '✅' : '❌';
        await 制作聊天记录(e, result.message, `${icon} Terminal`, `命令: ${msg} | 返回代码: ${result.code} | 用时: ${this.getExecutionTime(result)}秒`);
      } else {
        await e.reply('✅ 命令执行完成，无输出', true);
      }
    } catch (error) {
      logger.error(`[终端工具] 命令执行错误: ${error.stack || error.message}`);
      await e.reply(`❌ 执行错误: ${error.message}`);
    }

    return true;
  }

  /** 获取执行时间 */
  getExecutionTime(result) {
    if (result.startTime && result.endTime) {
      return ((result.endTime - result.startTime) / 1000).toFixed(2);
    }
    return '未知';
  }

  /** 在用户主目录执行终端命令 */
  async runTerminalhome(e) {
    let msg = e.msg.replace(/^rh\s*/i, '').trim();
    if (!msg) return false;

    if (config.get('blacklist', true)) {
      const banList = config.get('ban', []);
      for (const bannedCmd of banList) {
        if (msg.includes(bannedCmd)) {
          await e.reply(`❌ 命令 "${msg}" 包含禁用关键词 "${bannedCmd}"`, true);
          logger.debug(`已拦截黑名单命令: ${msg}`);
          return true;
        }
      }
    }

    try {
      const homePath = process.env.HOME || os.homedir();
      const options = {
        cwd: homePath,
        shell: config.get('shell', true),
        stdio: 'pipe',
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, FORCE_COLOR: '1' },
      };

      const timeout = config.get('timeout', 300000);
      const result = await terminal.execute(e, msg, options, timeout);

      history.add(msg, 'terminal', result.code);

      if (result.message) {
        const icon = result.code === 0 ? '✅' : '❌';
        await 制作聊天记录(e, result.message, `${icon} Terminal (HOME)`, `目录: ${homePath} | 命令: ${msg} | 返回代码: ${result.code}`);
      } else {
        await e.reply('✅ 命令执行完成，无输出', true);
      }
    } catch (error) {
      logger.error(`[终端工具] 命令执行错误: ${error.stack || error.message}`);
      await e.reply(`❌ 执行错误: ${error.message}`);
    }

    return true;
  }

  /** 访问对象或属性 - 用于简化的对象获取 */
  async accessObject(e) {
    let msg = e.msg.replace(/^roj\s*/i, '').trim();
    if (!msg) return false;
    const globalContext = this.getGlobalContext();
    globalContext.e = e;

    try {
      let target;
      let objName = msg;
      if (msg.includes('.') || msg.includes('[')) {
        let current = globalContext;
        const pathParts = [];
        let tempPath = '';
        let inBracket = false;
        let inQuote = false;
        let quoteChar = '';
        for (let i = 0; i < msg.length; i++) {
          const char = msg[i];

          if (char === '.' && !inBracket && !inQuote) {
            if (tempPath) {
              pathParts.push(tempPath);
              tempPath = '';
            }
          }
          else if (char === '[' && !inBracket && !inQuote) {
            if (tempPath) {
              pathParts.push(tempPath);
              tempPath = '';
            }
            inBracket = true;
          }
          else if (char === ']' && inBracket && !inQuote) {
            inBracket = false;
            pathParts.push(tempPath);
            tempPath = '';
          }
          else if ((char === '"' || char === "'") && !inQuote && inBracket) {
            inQuote = true;
            quoteChar = char;
          }
          else if (char === quoteChar && inQuote) {
            inQuote = false;
          }
          else {
            tempPath += char;
          }
        }

        if (tempPath) {
          pathParts.push(tempPath);
        }
        let baseName = pathParts[0];
        if (!(baseName in globalContext)) {
          throw new Error(`基础对象 '${baseName}' 不存在`);
        }

        current = globalContext[baseName];
        let path = baseName;

        for (let i = 1; i < pathParts.length; i++) {
          let part = pathParts[i];
          if (inBracket && !isNaN(part)) {
            part = parseInt(part);
          }

          if (current === undefined || current === null) {
            throw new Error(`访问 '${path}' 时遇到 ${current === null ? 'null' : 'undefined'} 值`);
          }

          if (!(part in current)) {
            throw new Error(`属性 '${part}' 在 '${path}' 中不存在`);
          }

          current = current[part];
          path += typeof part === 'number' ? `[${part}]` : `.${part}`;
        }

        target = current;
        objName = path;
      }
      else {
        if (!(msg in globalContext)) {
          throw new Error(`对象 '${msg}' 不存在于全局上下文中`);
        }
        target = globalContext[msg];
      }
      if (target === undefined) {
        await e.reply(`❓ 对象 '${objName}' 不存在或结果为 undefined`, true);
        return true;
      }

      const result = inspector.inspect(target, objName);
      await 制作聊天记录(e, inspector.formatResult(result), `👁️ ${objName} 对象详情`, `类型: ${result.type} | 属性: ${result.propertyCount || 0} | 方法: ${result.methodCount || 0}`);

    } catch (error) {
      await e.reply(`❌ 访问对象错误: ${error.message}`, true);
      logger.error(`[终端工具] 对象访问错误: ${error.stack || error.message}`);
    }

    return true;
  }

  /** 执行方法 */
  async runMethod(e) {
    let msg = e.msg.replace(/^rj\s*/i, '').trim();
    if (!msg) return false;
  
    const globalContext = this.getGlobalContext();
    globalContext.segment = global.segment;
    globalContext.e = e;
    const startTime = Date.now();
  
    try {
      let result;
      const methodMatch = msg.match(/^([\w.[\]"']+)\s*\((.*)\)$/);
      let methodExecuted = false;
  
      if (methodMatch) {
        try {
          // 尝试解析并执行方法调用
          const methodPath = methodMatch[1];
          const argsStr = methodMatch[2].trim();
  
          let current = globalContext;
          const pathParts = [];
          let tempPath = '';
          let inBracket = false;
  
          for (let i = 0; i < methodPath.length; i++) {
            const char = methodPath[i];
  
            if (char === '.' && !inBracket) {
              if (tempPath) {
                pathParts.push(tempPath);
                tempPath = '';
              }
            }
            else if (char === '[') {
              if (tempPath) {
                pathParts.push(tempPath);
                tempPath = '';
              }
              inBracket = true;
              tempPath += char;
            }
            else if (char === ']' && inBracket) {
              tempPath += char;
              pathParts.push(tempPath);
              tempPath = '';
              inBracket = false;
            }
            else {
              tempPath += char;
            }
          }
  
          if (tempPath) {
            pathParts.push(tempPath);
          }
  
          if (pathParts.length === 0) {
            throw new Error(`无效的方法路径: ${methodPath}`);
          }
  
          const baseObjName = pathParts[0];
          if (!(baseObjName in globalContext)) {
            throw new Error(`对象 '${baseObjName}' 不存在`);
          }
  
          current = globalContext[baseObjName];
          let currentPath = baseObjName;
  
          for (let i = 1; i < pathParts.length - 1; i++) {
            let part = pathParts[i];
  
            // 处理数组索引
            if (part.startsWith('[') && part.endsWith(']')) {
              const indexStr = part.substring(1, part.length - 1);
              // 处理引号
              if ((indexStr.startsWith('"') && indexStr.endsWith('"')) ||
                (indexStr.startsWith("'") && indexStr.endsWith("'"))) {
                part = indexStr.substring(1, indexStr.length - 1);
              }
              // 处理数字索引
              else if (!isNaN(indexStr)) {
                part = parseInt(indexStr);
              }
              else {
                part = indexStr;
              }
            }
  
            if (current === null || current === undefined) {
              throw new Error(`对象路径 '${currentPath}' 为 ${current === null ? 'null' : 'undefined'}`);
            }
  
            if (!(part in current)) {
              throw new Error(`属性 '${part}' 在 '${currentPath}' 中不存在`);
            }
  
            current = current[part];
            currentPath += typeof part === 'number' ? `[${part}]` : `.${part}`;
          }
  
          let methodName = pathParts[pathParts.length - 1];
  
          if (methodName.startsWith('[') && methodName.endsWith(']')) {
            const indexStr = methodName.substring(1, methodName.length - 1);
            if ((indexStr.startsWith('"') && indexStr.endsWith('"')) ||
              (indexStr.startsWith("'") && indexStr.endsWith("'"))) {
              methodName = indexStr.substring(1, indexStr.length - 1);
            }
            else if (!isNaN(indexStr)) {
              methodName = parseInt(indexStr);
            }
            else {
              methodName = indexStr;
            }
          }
  
          if (current === null || current === undefined) {
            throw new Error(`对象 '${currentPath}' 为 ${current === null ? 'null' : 'undefined'}`);
          }
  
          if (!(methodName in current)) {
            throw new Error(`方法 '${methodName}' 在 '${currentPath}' 中不存在`);
          }
  
          if (typeof current[methodName] !== 'function') {
            throw new Error(`'${methodName}' 不是一个方法，而是一个 ${typeof current[methodName]}`);
          }
  
          let args = [];
          if (argsStr) {
            try {
              if (argsStr.includes('{') || argsStr.includes('=>') ||
                argsStr.includes('function') || argsStr.includes('new ') ||
                argsStr.includes('this')) {
                const argsFunc = new Function('globalContext', `with(globalContext){return [${argsStr}];}`);
                args = argsFunc(globalContext);
              } else {
                args = JSON.parse(`[${argsStr}]`);
              }
            } catch (parseError) {
              throw new Error(`参数解析错误: ${parseError.message}`);
            }
          }
  
          // 执行方法
          result = await current[methodName].apply(current, args);
          methodExecuted = true;
        } catch (methodError) {
          logger.debug(`[终端工具] 方法解析失败，将尝试作为表达式执行: ${methodError.message}`);
          methodExecuted = false;
        }
      }
      if (!methodExecuted) {
        try {
          const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
          const contextKeys = Object.keys(globalContext);
          const contextValues = contextKeys.map((key) => globalContext[key]);
          try {
            const valueFunction = new AsyncFunction(...contextKeys, `return (${msg});`);
            result = await valueFunction(...contextValues);
          } catch (valueError) {
            if (/SyntaxError: (Unexpected|await|Illegal return)/.test(valueError)) {
              const stmtFunction = new AsyncFunction(...contextKeys, msg);
              result = await stmtFunction(...contextValues);
            } else {
              throw valueError;
            }
          }
        } catch (evalError) {
          if (/SyntaxError: (await|Illegal return|Unexpected)/.test(evalError)) {
            const asyncFunction = new AsyncFunction(...contextKeys,
              `return (async function() {
                try {
                  ${msg}
                } catch (err) {
                  throw err;
                }
              }).apply(this);`
            );
            result = await asyncFunction(...contextValues);
          } else {
            throw evalError;
          }
        }
      }
  
      const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);
  
      let output;
      let subtitle = `用时: ${executionTime}秒`;
  
      if (result === undefined) {
        output = '命令执行完成，无返回值 (undefined)';
      } else if (result === null) {
        output = 'null';
      } else if (typeof result === 'object') {
        const objResult = inspector.inspect(result, `执行结果`);
        output = inspector.formatResult(objResult);
        subtitle = `类型: ${objResult.type} | 属性: ${objResult.propertyCount || 0} | 方法: ${objResult.methodCount || 0} | 用时: ${executionTime}秒`;
      } else {
        output = String(result);
      }
  
      // 截断过长输出
      const maxOutputLength = config.get('maxOutputLength', 5000);
      if (output.length > maxOutputLength) {
        output = output.slice(0, maxOutputLength) + `\n\n... 输出被截断 (共 ${output.length} 字符)`;
      }
  
      await 制作聊天记录(e, output, `✅ JavaScript 执行结果`, subtitle);
  
    } catch (error) {
      await e.reply(`❌ 执行错误: ${error.message}`, true);
      logger.error(`[终端工具] JavaScript执行错误: ${error.stack || error.message}`);
    }
  
    return true;
  }

  /** 获取全局上下文对象 */
  getGlobalContext() {
    return {
      Bot: global.Bot,
      segment: global.segment,
      e: null,
      plugin: this,
      logger: global.logger,
      common: common,
      cfg: cfg,
      process: process,
      os: os,
      fs: fs,
      path: path,
      moment: moment,
      util: util,
      terminal: terminal,
      config: config,
      history: history,
      YAML: YAML,
      fetch: fetch,
      axios: axios,
      crypto: crypto,
      zlib: zlib,
      querystring: querystring,
      url: url,
      stream: stream,
      events: events,
      readline: readline,
    };
  }

  /** 格式化回复内容 */
  formatReplyContent(content) {
    if (typeof content === 'string') {
      // 如果内容过长，进行截断
      if (content.length > 50) {
        return content.substring(0, 47) + '...';
      }
      return content;
    } else if (Array.isArray(content)) {
      return '[数组消息]';
    } else if (typeof content === 'object' && content !== null) {
      return '[对象消息]';
    } else {
      return String(content);
    }
  }

  /** 显示历史记录 */
  async showHistory(e) {
    let match = /^rrl\s*(\w*)\s*(\d*)\s*$/i.exec(e.msg);
    let type = match[1]?.toLowerCase() || '';
    let limit = match[2] ? parseInt(match[2]) : 10;

    // 检查是否为清除命令
    if (type === 'clear' || type === 'c') {
      const result = history.clear();
      if (result) {
        await e.reply('✅ 命令历史记录已清空', true);
      } else {
        await e.reply('❌ 清空历史记录失败', true);
      }
      return true;
    }

    let historyType = null;
    let title = '命令历史记录';
    let icon = '📜';

    if (type === 't' || type === 'terminal') {
      historyType = 'terminal';
      title = '终端命令历史';
      icon = '🖥️';
    } else if (type === 'j' || type === 'js' || type === 'javascript') {
      historyType = 'javascript';
      title = 'JavaScript代码历史';
      icon = '📝';
    }

    const historyItems = history.get(limit, historyType);
    if (historyItems.length === 0) {
      await e.reply(`${icon} 暂无${title}`, true);
      return true;
    }

    let historyText = '';
    for (let i = 0; i < historyItems.length; i++) {
      const item = historyItems[i];
      const time = moment(item.timestamp).format('MM-DD HH:mm');
      const status = item.code === 0 ? '✅' : '❌';
      const typeIcon = item.type === 'terminal' ? '🖥️' : '📝';
      let command = item.command;
      if (command.length > 50) {
        command = command.substring(0, 47) + '...';
      }
      historyText += `${i + 1}. ${status} ${typeIcon} [${time}]\n   ${command}\n\n`;
    }

    await 制作聊天记录(e, historyText.trim(), `${icon} ${title}`, `共 ${historyItems.length} 条记录`);
    return true;
  }

  /** 配置工具 */
  async configTool(e) {
    let cmd = e.msg.replace(/^rc\s*/i, '').trim().toLowerCase();

    // 显示当前配置
    if (!cmd || cmd === 'show' || cmd === 'list') {
      const configData = config.config;
      let configText = '【工具配置】\n';

      for (const [key, value] of Object.entries(configData)) {
        configText += `• ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}\n`;
      }

      await e.reply(configText, true);
      return true;
    }

    // 设置配置
    const setMatch = /^set\s+(\w+)\s+(.+)$/i.exec(cmd);
    if (setMatch) {
      const key = setMatch[1];
      let value = setMatch[2];

      try {
        if (value.toLowerCase() === 'true') {
          value = true;
        } else if (value.toLowerCase() === 'false') {
          value = false;
        } else if (!isNaN(value)) {
          value = Number(value);
        } else if (value.startsWith('[') && value.endsWith(']')) {
          value = JSON.parse(value);
        } else if (value.startsWith('{') && value.endsWith('}')) {
          value = JSON.parse(value);
        }
      } catch (error) {
      }

      config.set(key, value);
      await e.reply(`✅ 配置已更新: ${key} = ${value}`, true);
      return true;
    }

    // 重置配置
    if (cmd === 'reset') {
      fs.unlinkSync(config.configPath);
      config = new ToolsConfig(configFile);
      await e.reply('✅ 配置已重置为默认值', true);
      return true;
    }

    // 帮助信息
    await e.reply(`📋 配置命令帮助:
rc - 显示当前配置
rc set <key> <value> - 设置配置项
rc reset - 重置为默认配置`, true);
    return true;
  }
}