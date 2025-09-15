import fs from 'fs';
import path from 'path';
const _path = process.cwd();
import { takeScreenshot } from '../../../lib/common/takeScreenshot.js';
import { 制作聊天记录 } from '../../../lib/util.js';

function loadCityData() {
    try {
        const dataPath = path.join(_path, './plugins/XRK/resources/weather/weather.json');
        const rawData = fs.readFileSync(dataPath, 'utf8');
        return JSON.parse(rawData);
    } catch (error) {
        console.error('加载城市数据失败:', error);
        return [];
    }
}

let cityData = loadCityData();

export class weather extends plugin {
    constructor() {
        super({
            name: '向日葵查天气',
            dsc: '向日葵查天气',
            event: 'message',
            priority: 500,
            rule: [
                { reg: "#查天气(.*)$", fnc: 'search_weather' }
            ]
        });
    }

    removeSuffix(cityName) {
        const suffixes = ['乡', '镇', '县', '市', '区'];
        for (const suffix of suffixes) {
            if (cityName.endsWith(suffix)) {
                return cityName.slice(0, -1);
            }
        }
        return cityName;
    }

    tryWithSuffixes(cityName) {
        const suffixes = ['市', '县', '区', '镇', '乡'];
        const results = [];
        
        for (const suffix of suffixes) {
            const cityWithSuffix = cityName + suffix;
            for (const province of cityData) {
                const areas = province.Area.split(' ');
                const enAreas = province.En_Area.split(' ');
                
                const index = areas.findIndex(area => area === cityWithSuffix);
                if (index !== -1) {
                    results.push({
                        provinceCode: province.province_code,
                        enCity: enAreas[index],
                        matchedName: cityWithSuffix
                    });
                }
            }
        }
        return results;
    }

    findCityInfo(searchCity) {
        for (const province of cityData) {
            const areas = province.Area.split(' ');
            const enAreas = province.En_Area.split(' ');
            
            const index = areas.findIndex(area => area === searchCity);
            if (index !== -1) {
                return {
                    provinceCode: province.province_code,
                    enCity: enAreas[index],
                    matchedName: searchCity
                };
            }
        }

        const cityWithoutSuffix = this.removeSuffix(searchCity);
        if (cityWithoutSuffix !== searchCity) {
            for (const province of cityData) {
                const areas = province.Area.split(' ');
                const enAreas = province.En_Area.split(' ');
                
                const index = areas.findIndex(area => area === cityWithoutSuffix);
                if (index !== -1) {
                    return {
                        provinceCode: province.province_code,
                        enCity: enAreas[index],
                        matchedName: cityWithoutSuffix
                    };
                }
            }
        }
        const suffixResults = this.tryWithSuffixes(cityWithoutSuffix);
        return suffixResults.length > 0 ? suffixResults[0] : null;
    }
    async makeForwardMsg(e, messages, title, entitle) {
        await 制作聊天记录(e, messages, title, entitle);
      }

    async search_weather(e) {
        const match = e.msg.match(/#查天气(.*)$/);
        if (!match || !match[1]) {
            await this.reply('请输入正确的城市名，例如:#查天气北京 上海 广州');
            return;
        }

        const cities = match[1].trim().split(/\s+/);
        if (cities.length === 0) {
            await this.reply('请输入正确的城市名，例如:#查天气北京 上海 广州');
            return;
        }

        const messages = [];
        const xrk = [];
        const errorCities = [];

        for (const city of cities) {
            const cityInfo = this.findCityInfo(city);
            if (!cityInfo) {
                errorCities.push(city);
                continue;
            }

            try {
                const weatherUrl = `http://www.nmc.cn/publish/forecast/${cityInfo.provinceCode}/${cityInfo.enCity}.html`;
                const screenshotConfig = {
                    width: 1024,
                    height: 768,
                    quality: 100,
                    type: 'jpeg',
                    selector: null,
                    topCutRatio: 0.055,
                    bottomCutRatio: 0.225,
                    leftCutRatio: 0,
                    rightCutRatio: 0,
                    waitForSelector: null,
                    waitForTimeout: null,
                    waitUntil: 'networkidle2',
                    fullPage: false
                };

                const imagePath = await takeScreenshot(weatherUrl, `weather_${cityInfo.enCity}`, screenshotConfig);
                
                let cityMsg = [];
                cityMsg.push(`${city}的天气信息`);
                xrk.push(`${city}`)
                messages.push(cityMsg);
                messages.push(segment.image(imagePath));
            } catch (error) {
                console.error(`获取${city}天气信息失败:`, error);
                errorCities.push(city);
            }
        }
        if (messages.length === 0 && errorCities.length > 0) {
            await this.reply(`无法获取任何城市的天气信息，请检查城市名称是否正确。\n${errorCities.join('、')}`);
            return;
        }
        if (messages.length > 0) {
           await 制作聊天记录(e, messages, '向日葵查天气', xrk);
        }

        if (errorCities.length > 0) {
            await this.reply(`以下城市的天气信息获取失败，请检查城市名称是否正确：\n${errorCities.join('、')}`);
        }
    }
}