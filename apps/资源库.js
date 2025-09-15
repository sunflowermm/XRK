import plugin from '../../../lib/plugins/plugin.js';
import { 解析网页json } from '../components/config.js';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

const URLS = {
  img: {
    random: 'https://www.dmoe.cc/random.php?return=json',
    touhou: 'https://img.paulzzh.com/touhou/random',
    anime: 'https://api.mtyqx.cn/api/random.php',
    meizi: 'https://api.mmp.cc/api/kswallpaper?category=meizi&type=jpg',
    ks: 'https://api.mmp.cc/api/kswallpaper?category=kuaishou&type=jpg',
    cos: 'https://api.mmp.cc/api/kswallpaper?category=cos&type=jpg'
  },
  video: {
    baisi: 'http://api.mmp.cc/api/ksvideo?type=json&id=BaiSi',
    jk: 'http://api.mmp.cc/api/ksvideo?type=json&id=jk',
    heisi: 'http://api.mmp.cc/api/ksvideo?type=json&id=HeiSi',
    rewu: 'http://api.mmp.cc/api/ksvideo?type=json&id=ReWu',
    gzlxjj: 'http://api.mmp.cc/api/ksvideo?type=json&id=GaoZhiLiangXiaoJieJie',
    luoli: 'http://api.mmp.cc/api/ksvideo?type=json&id=LuoLi',
    random: 'http://api.mmp.cc/api/ksvideo?type=json'
  }
};

export class AvatarPlugin extends plugin {
  constructor() {
    super({
      name: '向日葵资源库',
      dsc: '向日葵资源库',
      event: 'message',
      priority: 1,
      rule: [
        { reg: "^#?随机图片", fnc: 'img_random' },
        { reg: "^#?(随机)?东方图", fnc: 'img_touhou' },
        { reg: "^#?(随机)?二次元图", fnc: 'img_anime' },
        { reg: "^#?白丝(视频)?", fnc: 'vid_baisi' },
        { reg: "^#?黑丝(视频)?", fnc: 'vid_heisi' },
        { reg: "^#?jk(视频)?", fnc: 'vid_jk' },
        { reg: "^#?高质量小姐姐(视频)?", fnc: 'vid_gzlxjj' },
        { reg: "^#?热舞(视频)?", fnc: 'vid_rewu' },
        { reg: "^#?萝莉(视频)?", fnc: 'vid_luoli' },
        { reg: "^#?小姐姐(视频)?", fnc: 'vid_random' },
        { reg: "^#?ks网红", fnc: 'img_ks' },
        { reg: "^#?cos图", fnc: 'img_cos' },
        { reg: "^#?妹子图", fnc: 'img_meizi' }
      ]
    });
    this._path = process.cwd();
    this.configDir = path.join(this._path, 'data', 'xrkconfig');
    this.configFile = path.join(this.configDir, 'config.yaml');
  }

  async checkSharing() {
    try {
      const config = YAML.parse(fs.readFileSync(this.configFile, 'utf8'));
      if (!config.sharing) {
        return false;
      }
      return true;
    } catch (error) {
      console.error('读取配置文件失败:', error);
      await this.e.reply('配置文件读取失败，功能已禁用');
      return false;
    }
  }

  async sendImg(url) {
    if (!await this.checkSharing()) return false;
    await this.e.reply(['芝士你要的图片', segment.image(url)]);
    return true;
  }

  async sendVideo(url) {
    if (!await this.checkSharing()) return false;
    const data = await 解析网页json(url);
    if (data.status !== 'success') return false;
    await this.e.reply([segment.video(data.link), '看吧涩批！']);
  }

  async img_random(e) {
    if (!await this.checkSharing()) return false;
    const data = await 解析网页json(URLS.img.random);
    if (data.code !== '200') return false;
    return this.sendImg(data.imgurl);
  }

  img_touhou(e) { return this.sendImg(URLS.img.touhou); }
  img_anime(e) { return this.sendImg(URLS.img.anime); }
  img_meizi(e) { return this.sendImg(URLS.img.meizi); }
  img_ks(e) { return this.sendImg(URLS.img.ks); }
  img_cos(e) { return this.sendImg(URLS.img.cos); }
  vid_baisi(e) { return this.sendVideo(URLS.video.baisi); }
  vid_heisi(e) { return this.sendVideo(URLS.video.heisi); }
  vid_jk(e) { return this.sendVideo(URLS.video.jk); }
  vid_gzlxjj(e) { return this.sendVideo(URLS.video.gzlxjj); }
  vid_rewu(e) { return this.sendVideo(URLS.video.rewu); }
  vid_luoli(e) { return this.sendVideo(URLS.video.luoli); }
  vid_random(e) { return this.sendVideo(URLS.video.random); }
}