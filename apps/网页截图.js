import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { takeScreenshot } from '../../../lib/common/takeScreenshot.js';
import yaml from 'yaml';

export class WebpageScreenshot extends plugin {
  constructor() {
    super({
      name: '网页截图',
      dsc: '自动识别消息中的链接并截图',
      event: 'message',
      priority: 999999,
      rule: [
        {
          reg: /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi,
          fnc: 'autoScreenshot',
          log: false
        }
      ]
    });
    this.loadConfig();
  }

  loadConfig() {
    try {
      const configPath = path.join(process.cwd(), 'plugins/XRK/config/httpsscreenshot.json');
      const configfilePath = path.join(process.cwd(), 'data/xrkconfig/config.yaml');
      this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      this.fileconfig = yaml.parse(fs.readFileSync(configfilePath, 'utf8'));
      this.screenshotConfig = this.config.screenshotConfig;
    } catch (error) {}
  }

  extractUrls(message) {
    if (!message || typeof message !== 'string') return [];
    
    // 简化的URL提取正则
    const urlRegex = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;
    const matches = message.match(urlRegex) || [];
    
    // 去重并处理提取的URL
    const urls = new Set();
    const seenDomains = new Set();
    const { maxUrlsPerMessage, minUrlLength, maxUrlLength } = this.config.urlProcessing;
    
    for (let url of matches) {
      if (urls.size >= maxUrlsPerMessage) break;
      
      url = url.trim();
      if (!url || url.length < minUrlLength || url.length > maxUrlLength) continue;
      
      // 规范化URL
      url = this.cleanAndNormalizeUrl(url);
      if (!url) continue;
      
      try {
        const urlObj = new URL(url);
        const domain = urlObj.hostname.toLowerCase();
        
        // 验证域名
        if (!this.isValidDomain(domain)) continue;
        if (seenDomains.has(domain)) continue;
        
        // 检查文件类型
        if (this.isBlockedFileType(urlObj.pathname)) continue;
        
        // 清理参数并添加到结果
        url = this.cleanUrlParameters(urlObj);
        urls.add(url);
        seenDomains.add(domain);
      } catch (err) {
        // 静默忽略无效URL
        continue;
      }
    }
    
    return Array.from(urls);
  }

  cleanAndNormalizeUrl(url) {
    try {
      url = url
        .replace(/[.,!?;:'")}]+$/, '')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/g, '')
        .trim();
      if (!/^https?:\/\//i.test(url)) {
        url = (this.isLocalAddress(url)) ? 'http://' + url : 'https://' + url;
      }
      
      const urlObj = new URL(url);
      
      // 规范化路径
      urlObj.pathname = decodeURIComponent(urlObj.pathname)
        .replace(/\/+/g, '/')
        .replace(/\/{2,}/g, '/');
      
      // 规范化查询参数
      urlObj.search = decodeURIComponent(urlObj.search)
        .replace(/[&?]$/, '');
      
      // 移除默认端口
      if ((urlObj.protocol === 'http:' && urlObj.port === '80') ||
          (urlObj.protocol === 'https:' && urlObj.port === '443')) {
        urlObj.port = '';
      }
      
      // 清除凭证
      urlObj.username = '';
      urlObj.password = '';
      
      // 返回规范化URL
      return urlObj.toString()
        .replace(/\/$/, '')
        .replace(/([^:]\/)\/+/g, '$1');
    } catch (err) {
      return null;
    }
  }

  cleanUrlParameters(urlObj) {
    const searchParams = new URLSearchParams(urlObj.search);
    
    // 移除过滤的参数
    for (const param of this.config.filteredParams) {
      searchParams.delete(param);
    }
    
    // 移除空参数
    for (const [key, value] of searchParams.entries()) {
      if (!value.trim()) {
        searchParams.delete(key);
      }
    }
    
    urlObj.search = searchParams.toString();
    return urlObj.toString();
  }

  isValidDomain(domain) {
    domain = domain.toLowerCase();
    
    // 检查白名单
    if (this.config.whitelistDomains.some(d => domain.includes(d))) {
      return true;
    }
    
    // 检查黑名单
    if (this.config.blacklistDomains.some(d => domain.includes(d))) {
      return false;
    }
    
    // 检查IP地址
    if (this.isIPAddress(domain)) {
      return this.isAllowedIP(domain);
    }
    
    // 检查本地地址
    if (this.isLocalAddress(domain)) {
      return this.config.allowedLocalAddresses.includes(domain);
    }
    
    return true;
  }

  isBlockedFileType(pathname) {
    const extension = pathname.split('.').pop()?.toLowerCase();
    if (!extension) return false;
    
    return Object.values(this.config.blockedExtensions)
      .flat()
      .includes(extension);
  }

  isIPAddress(host) {
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
  }

  isAllowedIP(ip) {
    if (this.config.allowedLocalAddresses.includes(ip)) return true;
    return !this.config.blacklistIPs.some(range => this.isIPInRange(ip, range));
  }

  isIPInRange(ip, range) {
    try {
      const [rangeIP, bits] = range.split('/');
      const ipLong = this.ipToLong(ip);
      const rangeLong = this.ipToLong(rangeIP);
      const mask = -1 << (32 - parseInt(bits));
      return (ipLong & mask) === (rangeLong & mask);
    } catch (err) {
      return false;
    }
  }

  ipToLong(ip) {
    return ip.split('.')
      .reduce((long, octet) => (long << 8) + parseInt(octet), 0) >>> 0;
  }

  isLocalAddress(host) {
    if (!host) return false;
    try {
      return this.config.allowedLocalAddresses.some(addr => 
        host.startsWith(addr) || host.includes(addr)
      );
    } catch (err) {
      return false;
    }
  }

  async isValidUrl(url) {
    try {
      const response = await fetch(url, { 
        method: 'HEAD', 
        timeout: 3000,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      return response.status >= 200 && response.status < 400;
    } catch (error) {
      // 对于本地地址，即使连接失败也允许尝试
      const urlObj = new URL(url);
      if (this.isLocalAddress(urlObj.hostname)) {
        return true;
      }
      return false;
    }
  }

  async processUrl(url) {
    try {
      const fileName = `screenshot_${Date.now()}`;
      const imagePath = await takeScreenshot(url, fileName, this.screenshotConfig);

      if (!fs.existsSync(imagePath)) {
        throw new Error('截图文件未找到');
      }

      return segment.image(imagePath);
    } catch (error) {
      // 静默处理截图失败
      return null;
    }
  }

  async autoScreenshot(e) {
    if (!this.fileconfig.screen_shot_http) {
      return false;
    }
    
    try {
      // 提取URL
      const urls = this.extractUrls(e.msg);
      if (urls.length === 0) return false;
      
      // 验证URL可访问性
      const validUrls = [];
      for (const url of urls) {
        // 验证URL可访问性
        if (await this.isValidUrl(url)) {
          validUrls.push(url);
        }
      }
      
      if (validUrls.length === 0) return false;
      
      // 处理截图
      const screenshotSegments = [];
      for (const url of validUrls.slice(0, this.config.urlProcessing.maxUrlsPerMessage)) {
        const screenshot = await this.processUrl(url);
        if (screenshot) {
          screenshotSegments.push(screenshot);
        }
      }
      
      if (screenshotSegments.length === 0) {
        return true;
      }
      
      // 发送截图
      try {
        if (screenshotSegments.length > 1) {
          const forwardMsg = await this.makeForwardMsg(e, screenshotSegments, '网页截图');
          if (forwardMsg) {
            await e.reply(forwardMsg);
          }
        } else {
          await e.reply(screenshotSegments[0]);
        }
      } catch (error) { 
        for (const segment of screenshotSegments) {
          try {
            await e.reply(segment);
            await new Promise(resolve => setTimeout(resolve, 1000));
          } catch (err) {
          }
        }
      }
    } catch (error) {}
    
    return true;
  }

  async makeForwardMsg(e, messages, title = '网页截图') {
    const nickname = Bot.nickname;
    const user_id = Bot.uin;

    const forwardMessages = [
      {
        message: title,
        nickname,
        user_id,
        time: Math.floor(Date.now() / 1000),
      },
    ];

    messages.forEach((msg, idx) => {
      forwardMessages.push({
        message: msg,
        user_id,
        time: Math.floor(Date.now() / 1000) + idx + 1,
      });
    });

    try {
      if (e.isGroup) {
        return await e.group.makeForwardMsg(forwardMessages);
      } else {
        return await e.friend.makeForwardMsg(forwardMessages);
      }
    } catch (error) {
      return null;
    }
  }
}