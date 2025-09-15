import yaml from 'yaml';
import fs from 'fs';
import fetch from 'node-fetch';
import https from 'https';
import axios from 'axios';
const _path = process.cwd();
const CONFIG_PATH = `${_path}/data/xrkconfig/config.yaml`;
const agent = new https.Agent({
    rejectUnauthorized: false
});

/**
 * 解析yaml文件
 * @returns {Object}
 * @example
 * const config = yamlParse();
 * console.log(config);
 */

export function 解析向日葵插件yaml() {
    const file = fs.readFileSync(CONFIG_PATH, 'utf8');
    return yaml.parse(file);
 }

/**
 * 保存yaml文件
 * @param {string} path 文件路径
 * @param {Object} configObject 配置对象
 * @example
 * const config = yamlParse();
 * config.xxx = 'xxx';
 * 保存yaml(CONFIG_PATH, config);
 * 
 */

export async function 保存yaml(path, configObject) {
    try {
        const yamlContent = yaml.stringify(configObject);
        fs.writeFileSync(path, yamlContent, 'utf8');
    } catch (error) {
        console.error(`保存配置时出错: ${error.message}`);
    }
}

/**
 * 解析网页text
 * @param {string} url 网页链接
 * @returns {string}
 * @example
 * const text = await 解析网页text('https://www.baidu.com');
 * console.log(text);
 * 
 */
export async function 解析网页text(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`网络响应错误，状态码: ${response.status}`);
        }
        return await response.text();
    } catch (error) {
        throw new Error(`请求失败: ${error.message}`);
    }
}

/**
 * 解析网页json
 * @param {string} url 网页链接
 * @returns {Object}
 * @example
 * const json = await 解析网页json('https://www.baidu.com');
 * console.log(json);
 * 
 */
export async function 解析网页json(url) {
    try {
        const response = await axios.get(url, {
            httpsAgent: agent,
            timeout: 5000
        });
        return response.data;
    } catch (error) {
        console.error('请求详细错误:', error);
        throw new Error(`请求失败: ${error.message}`);
    }
}