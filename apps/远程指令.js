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
let inspector;

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

    this.outputDir = path.join(ROOT_PATH, 'data', 'terminal_output');
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  isLongRunningCommand(cmd) {
    const longRunningPatterns = [
      /\bgit\s+clone\b/i,
      /\bgit\s+pull\b/i,
      /\bgit\s+push\b/i,
      /\bgit\s+fetch\b/i,
      /\bgit\s+log\b/i,
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
      /\bfind\s+.*\s+-exec\b/i,
      /\bgrep\s+-r\b/i,
      /\bscp\b/i,
      /\brsync\b/i,
      /\bcp\s+-r\b/i,
      /\bmv\s+-r\b/i,
    ];
    return longRunningPatterns.some((pattern) => pattern.test(cmd));
  }

  isGitCommand(cmd) {
    return /\bgit\b/.test(cmd);
  }

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

    if (isGitCmd) {
      if (cmd.includes('git log')) {
        if (!cmd.includes('-n') && !cmd.includes('--max-count')) {
          cmd = cmd.replace(/git log/, 'git log -n 30');
        }
      }

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
      let chunkedOutput = [];
      const command = exec(this.formatPrompt(cmd), {
        ...options,
        maxBuffer: 10 * 1024 * 1024
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

        if (saveChunkedOutput && chunkedOutput.length > 0) {
          const completeOutput = chunkedOutput.join('\n\n');
          if (completeOutput.length > maxOutputLength * 2) {
            const outputFile = this.saveOutputToFile(cmd, completeOutput);
            if (outputFile) {
              finalOutput += `\n\n[完整输出太长，已保存到文件: ${outputFile}]`;
            }
          }
        }

        let formattedOutput = this.formatOutput(cmd, finalOutput || (code === 0 ? '任务已完成，无返回' : `执行失败，返回代码: ${code}`));

        if (formattedOutput.length > maxOutputLength) {
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
      maxDepth: options.maxDepth || 4,
      circularDetection: options.circularDetection !== false,
      showPrototype: options.showPrototype !== false,
      showGettersSetters: options.showGettersSetters !== false,
      showFunctions: options.showFunctions !== false,
      maxArrayItems: options.maxArrayItems || 30,
      maxStringLength: options.maxStringLength || 200,
      maxPropertiesPerObject: options.maxPropertiesPerObject || 100,
    };
  }

  inspect(obj, name = 'Object') {
    if (obj === null || obj === undefined) {
      return {
        name,
        type: obj === null ? 'null' : 'undefined',
        value: String(obj),
        properties: [],
        methods: [],
      };
    }

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
      const seen = new WeakMap();
      this.collectPropertiesAndMethods(obj, result, seen, 0);
      result.propertyCount = result.properties.length;
      result.methodCount = result.methods.length;

      result.properties.sort((a, b) => {
        const sourceOrder = { 'own': 0, 'array': 1, 'proto': 2, 'circular': 3 };
        if (sourceOrder[a.from] !== sourceOrder[b.from]) {
          return sourceOrder[a.from] - sourceOrder[b.from];
        }
        return a.name.localeCompare(b.name);
      });

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

  getType(obj) {
    if (obj === null) return 'null';
    if (obj === undefined) return 'undefined';

    if (obj._events && obj._eventsCount && typeof obj.emit === 'function') return 'EventEmitter';
    if (obj.group && obj.user_id && obj.message) return 'MessageEvent';
    if (obj.user_id && obj.nickname && !obj.message) return 'User';
    if (obj.group_id && obj.group_name) return 'Group';
    if (obj.sendMsg && obj.pickUser && obj.pickGroup) return 'Bot';

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

    if (typeof obj === 'function') {
      return obj.constructor.name === 'Function' ? 'Function' : obj.constructor.name;
    }

    if (typeof obj === 'object') {
      if (!obj.constructor) return 'Object';
      return obj.constructor.name;
    }

    return typeof obj;
  }

  formatValue(value, depth = 0) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';

    if (typeof value === 'string') {
      if (value.length > this.options.maxStringLength) {
        return `"${value.substring(0, this.options.maxStringLength - 3)}..."`;
      }
      return `"${value.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }

    if (typeof value === 'function') {
      let funcStr = value.toString();
      if (funcStr.includes('[native code]')) {
        return value.name ? `function ${value.name}() [native]` : 'function() [native]';
      }
      if (funcStr.length > 200) funcStr = funcStr.substring(0, 197) + '...';
      return funcStr;
    }

    if (typeof value === 'object') {
      if (depth > 2) return `[${this.getType(value)}]`;
      
      if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        const items = value.slice(0, this.options.maxArrayItems).map((item) => {
          return typeof item === 'object' && item !== null ? this.getType(item) : this.formatValue(item, depth + 1);
        });
        if (value.length > this.options.maxArrayItems) items.push(`...共${value.length}项`);
        return `[${items.join(', ')}]`;
      }

      if (value instanceof Date) return value.toISOString();
      if (value instanceof RegExp) return value.toString();
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      
      if (value instanceof Map) {
        return `Map(${value.size})`;
      }
      if (value instanceof Set) {
        return `Set(${value.size})`;
      }
      if (Buffer.isBuffer(value)) {
        return `Buffer(${value.length})`;
      }

      return `[${this.getType(value)}]`;
    }

    return String(value);
  }

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
          if (Array.isArray(obj) && ((!isNaN(parseInt(prop)) && parseInt(prop) < this.options.maxArrayItems) || prop === 'length')) continue;
          if (prop.startsWith('Symbol(') || prop === 'constructor' || prop === '_events' || prop === '_eventsCount') continue;

          const descriptor = Object.getOwnPropertyDescriptor(obj, prop);
          
          if (descriptor && (descriptor.get || descriptor.set)) {
            if (this.options.showGettersSetters) {
              let accessorValue = '无法访问';
              if (descriptor.get) {
                try {
                  const value = obj[prop];
                  accessorValue = this.formatValue(value);
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

      if (this.options.showPrototype) {
        try {
          const proto = Object.getPrototypeOf(obj);
          if (proto && proto !== Object.prototype && proto !== Function.prototype) {
            let protoProps = [];
            try {
              protoProps = Object.getOwnPropertyNames(proto);
            } catch (protoPropsError) {
              // 静默处理
            }

            for (const prop of protoProps) {
              if (prop === 'constructor' || prop.startsWith('__')) continue;

              try {
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
                }
              } catch (protoError) {
                // 跳过原型属性错误
              }
            }
          }
        } catch (protoAccessError) {
          // 静默处理
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

  extractFunctionParams(func) {
    try {
      const funcStr = func.toString();
      if (funcStr.includes('[native code]')) {
        return '';
      }

      const arrowMatch = funcStr.match(/^\s*(?:async\s*)?(?:\(([^)]*)\)|(\w+))\s*=>\s*/);
      if (arrowMatch) return arrowMatch[1] || arrowMatch[2] || '';
      const paramsMatch = funcStr.match(/^\s*(?:async\s*)?function(?:\s+\w+)?\s*\(([^)]*)\)/);
      return paramsMatch ? paramsMatch[1] : '';
    } catch (error) {
      return '(无法解析参数)';
    }
  }

  formatResult(result) {
    if (result.error) return `错误: ${result.error}`;

    let output = `【${result.name} 对象详情】\n`;
    output += `类型: ${result.type}\n`;
    if (result.value !== undefined) output += `值: ${result.value}\n`;
    output += `共 ${result.methodCount || 0} 个方法, ${result.propertyCount || 0} 个属性\n\n`;

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
 * JavaScript执行器
 */
class JavaScriptExecutor {
  constructor() {
    this.maxOutputLength = 5000;
  }

  /**
   * 格式化执行结果为字符串
   */
  formatResult(result) {
    if (result === undefined) return 'undefined';
    if (result === null) return 'null';
    
    // 基本类型直接转字符串
    if (typeof result === 'string') return result;
    if (typeof result === 'number') return String(result);
    if (typeof result === 'boolean') return String(result);
    if (typeof result === 'symbol') return result.toString();
    if (typeof result === 'bigint') return result.toString() + 'n';
    
    // 函数
    if (typeof result === 'function') {
      const funcStr = result.toString();
      if (funcStr.length > 200) {
        return funcStr.substring(0, 197) + '...';
      }
      return funcStr;
    }
    
    // 对象类型
    if (typeof result === 'object') {
      try {
        // 尝试使用 JSON.stringify
        const jsonStr = JSON.stringify(result, null, 2);
        if (jsonStr.length > this.maxOutputLength) {
          return jsonStr.substring(0, this.maxOutputLength - 3) + '...';
        }
        return jsonStr;
      } catch (e) {
        // 无法JSON化的对象，使用 util.inspect
        try {
          const inspectStr = util.inspect(result, { 
            depth: 3, 
            colors: false, 
            maxArrayLength: 100,
            breakLength: 80,
            compact: false 
          });
          if (inspectStr.length > this.maxOutputLength) {
            return inspectStr.substring(0, this.maxOutputLength - 3) + '...';
          }
          return inspectStr;
        } catch (inspectError) {
          // 最后的备选方案
          return `[${result.constructor?.name || 'Object'}]`;
        }
      }
    }
    
    return String(result);
  }

  /**
   * 执行JavaScript代码
   */
  async execute(code, globalContext) {
    const startTime = Date.now();
    
    try {
      const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
      const contextKeys = Object.keys(globalContext);
      const contextValues = contextKeys.map((key) => globalContext[key]);
      
      let result;
      
      // 首先尝试作为表达式执行
      try {
        const exprFunction = new AsyncFunction(...contextKeys, `return (${code});`);
        result = await exprFunction(...contextValues);
      } catch (exprError) {
        // 如果失败，尝试作为语句执行
        if (exprError instanceof SyntaxError) {
          try {
            const stmtFunction = new AsyncFunction(...contextKeys, code);
            result = await stmtFunction(...contextValues);
          } catch (stmtError) {
            // 如果还是失败，尝试包装在异步函数中
            if (stmtError instanceof SyntaxError) {
              const wrappedFunction = new AsyncFunction(...contextKeys,
                `return (async function() {
                  ${code}
                })();`
              );
              result = await wrappedFunction(...contextValues);
            } else {
              throw stmtError;
            }
          }
        } else {
          throw exprError;
        }
      }
      
      const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);
      
      return {
        success: true,
        result: result,
        executionTime: executionTime,
        resultType: typeof result === 'object' && result !== null ? 
          result.constructor?.name || 'Object' : 
          typeof result
      };
    } catch (error) {
      const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);
      
      return {
        success: false,
        error: error.message,
        stack: error.stack,
        executionTime: executionTime
      };
    }
  }
}

/**
 * 初始化组件
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

const jsExecutor = new JavaScriptExecutor();

/**
 * 增强型终端工具插件
 */
export class EnhancedTools extends plugin {
  constructor() {
    super({
      name: '终端工具',
      dsc: '执行终端命令和JavaScript代码',
      event: 'message',
      priority: 600,
      rule: [
        {
          reg: /^rx\s*([\s\S]*?)$/i,
          fnc: 'runTerminalXRK',
          permission: config.get('permission'),
        },
        {
          reg: /^rh\s*([\s\S]*?)$/i,
          fnc: 'runTerminalhome',
          permission: config.get('permission'),
        },
        {
          reg: /^roj\s*([\s\S]*?)$/i,
          fnc: 'runJavaScript',  // 改为直接执行JavaScript
          permission: config.get('permission'),
        },
        {
          reg: /^roi\s*([\s\S]*?)$/i,
          fnc: 'inspectObject',  // 新增：检查对象
          permission: config.get('permission'),
        },
        {
          reg: /^rj\s*([\s\S]*?)$/i,
          fnc: 'runMethod',
          permission: config.get('permission'),
        },
        {
          reg: /^rrl\s*(\w*)\s*(\d*)\s*$/i,
          fnc: 'showHistory',
          permission: config.get('permission'),
        },
        {
          reg: /^rc\s*([\s\S]*?)$/i,
          fnc: 'configTool',
          permission: config.get('permission'),
        },
      ],
    });
  }

  /** 执行终端命令（项目目录） */
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

  /** 执行终端命令（用户主目录） */
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

  /** 直接执行JavaScript代码（原生输出） */
  async runJavaScript(e) {
    let code = e.msg.replace(/^roj\s*/i, '').trim();
    if (!code) return false;

    const globalContext = this.getGlobalContext();
    globalContext.e = e;

    try {
      const result = await jsExecutor.execute(code, globalContext);
      
      history.add(code, 'javascript', result.success ? 0 : 1);

      if (result.success) {
        const output = jsExecutor.formatResult(result.result);
        const maxOutputLength = config.get('maxOutputLength', 5000);
        
        let finalOutput = output;
        if (output.length > maxOutputLength) {
          const outputFile = terminal.saveOutputToFile(code, output);
          if (outputFile) {
            finalOutput = output.substring(0, maxOutputLength) + 
              `\n\n... 输出太长 (${output.length} 字符)，完整输出已保存到: ${outputFile}`;
          } else {
            finalOutput = output.substring(0, maxOutputLength) + 
              `\n\n... 输出被截断 (共 ${output.length} 字符)`;
          }
        }
        
        await 制作聊天记录(
          e, 
          finalOutput, 
          '✅ JavaScript 执行结果', 
          `类型: ${result.resultType} | 用时: ${result.executionTime}秒`
        );
      } else {
        await e.reply(`❌ 执行错误: ${result.error}`, true);
        logger.error(`[终端工具] JavaScript执行错误: ${result.stack || result.error}`);
      }
    } catch (error) {
      await e.reply(`❌ 执行错误: ${error.message}`, true);
      logger.error(`[终端工具] JavaScript执行错误: ${error.stack || error.message}`);
    }

    return true;
  }

  /** 检查对象（详细信息） */
  async inspectObject(e) {
    let code = e.msg.replace(/^roi\s*/i, '').trim();
    if (!code) return false;

    const globalContext = this.getGlobalContext();
    globalContext.e = e;

    try {
      const execResult = await jsExecutor.execute(code, globalContext);
      
      if (execResult.success) {
        const result = inspector.inspect(execResult.result, code);
        await 制作聊天记录(
          e, 
          inspector.formatResult(result), 
          `👁️ 对象检查结果`, 
          `类型: ${result.type} | 属性: ${result.propertyCount || 0} | 方法: ${result.methodCount || 0}`
        );
      } else {
        await e.reply(`❌ 执行错误: ${execResult.error}`, true);
      }
    } catch (error) {
      await e.reply(`❌ 检查对象错误: ${error.message}`, true);
      logger.error(`[终端工具] 对象检查错误: ${error.stack || error.message}`);
    }

    return true;
  }

  /** 执行方法（兼容原有功能） */
  async runMethod(e) {
    let msg = e.msg.replace(/^rj\s*/i, '').trim();
    if (!msg) return false;

    const globalContext = this.getGlobalContext();
    globalContext.segment = global.segment;
    globalContext.e = e;

    try {
      const result = await jsExecutor.execute(msg, globalContext);
      
      history.add(msg, 'javascript', result.success ? 0 : 1);

      if (result.success) {
        const output = jsExecutor.formatResult(result.result);
        const maxOutputLength = config.get('maxOutputLength', 5000);
        
        let finalOutput = output;
        if (output.length > maxOutputLength) {
          const outputFile = terminal.saveOutputToFile(msg, output);
          if (outputFile) {
            finalOutput = output.substring(0, maxOutputLength) + 
              `\n\n... 输出太长 (${output.length} 字符)，完整输出已保存到: ${outputFile}`;
          } else {
            finalOutput = output.substring(0, maxOutputLength) + 
              `\n\n... 输出被截断 (共 ${output.length} 字符)`;
          }
        }
        
        await 制作聊天记录(
          e, 
          finalOutput, 
          '✅ JavaScript 执行结果', 
          `类型: ${result.resultType} | 用时: ${result.executionTime}秒`
        );
      } else {
        await e.reply(`❌ 执行错误: ${result.error}`, true);
        logger.error(`[终端工具] JavaScript执行错误: ${result.stack || result.error}`);
      }
    } catch (error) {
      await e.reply(`❌ 执行错误: ${error.message}`, true);
      logger.error(`[终端工具] JavaScript执行错误: ${error.stack || error.message}`);
    }

    return true;
  }

  /** 显示历史记录 */
  async showHistory(e) {
    let match = /^rrl\s*(\w*)\s*(\d*)\s*$/i.exec(e.msg);
    let type = match[1]?.toLowerCase() || '';
    let limit = match[2] ? parseInt(match[2]) : 10;

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

    if (!cmd || cmd === 'show' || cmd === 'list') {
      const configData = config.config;
      let configText = '【工具配置】\n';

      for (const [key, value] of Object.entries(configData)) {
        configText += `• ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}\n`;
      }

      await e.reply(configText, true);
      return true;
    }

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
        // 保持原值
      }

      config.set(key, value);
      await e.reply(`✅ 配置已更新: ${key} = ${value}`, true);
      return true;
    }

    if (cmd === 'reset') {
      fs.unlinkSync(config.configPath);
      config = new ToolsConfig(configFile);
      await e.reply('✅ 配置已重置为默认值', true);
      return true;
    }

    await e.reply(`📋 配置命令帮助:
rc - 显示当前配置
rc set <key> <value> - 设置配置项
rc reset - 重置为默认配置`, true);
    return true;
  }

  /** 获取执行时间 */
  getExecutionTime(result) {
    if (result.startTime && result.endTime) {
      return ((result.endTime - result.startTime) / 1000).toFixed(2);
    }
    return '未知';
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
}