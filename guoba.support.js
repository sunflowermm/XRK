import path from 'path';
import lodash from 'lodash';
import cfg from "./models/cfg.js";
import {_paths} from "./models/paths.js";

export function supportGuoba() {
  return {
    pluginInfo: {
      name: 'XRK',
      title: '向日葵插件',
      description: '支持icqq签名监测，插件安装，全局表情，整点报时，早报推送，刷zepp步数',
      author: ['@xrk114514'],
      authorLink: ['https://gitcode.com/Xrkseek'],
      link: 'https://gitcode.com/Xrkseek/XRK-Yunzai',
      isV3: true,
      isV2: false,
      showInMenu: 'auto',
      icon: 'emojione:sunflower'
    },
    
    configInfo: {
      schemas: [
        {
          label: '基础配置',
          component: 'SOFT_GROUP_BEGIN'
        },
        {
          field: 'signchecker',
          label: '签名检测',
          bottomHelpMessage: '基于ICQQ的签名监测，签名寄了自动换',
          component: 'Switch'
        },
        {
          field: 'help_priority',
          label: '帮助优先级',
          helpMessage: '设置帮助优先级，优先级越低越优先',
          component: 'InputNumber',
          componentProps: {
            defaultValue: 500,
            bordered: true,
            autofocus: true,
            controls: true
          }
        },
        {
          field: 'screen_shot_quality',
          label: '帮助渲染精度',
          component: 'Slider',
          componentProps: {
            dots: true,
            max: 3.00,
            min: 1.00,
            step: 0.01
          }
        },
        {
          field: 'emoji_filename',
          label: '偷图目录设置',
          component: 'Input',
          componentProps: {
            placeholder: '请输入目录名',
          }
        },
        {
          field: 'coremaster',
          label: '核心主人',
          bottomHelpMessage: '设置核心主人QQ，只能设置一个',
          helpMessage: '核心主人无法被其他主人删除',
          component: 'GSelectFriend',
          componentProps: {
            placeholder: '请选择核心主人QQ'
          }
        },
        {
          label: '推送配置',
          component: 'SOFT_GROUP_BEGIN'
        },
        {
          field: 'news_pushtime',
          label: '新闻日报推送时间',
          component: 'Slider',
          componentProps: {
            dots: true,
            max: 23,
            min: 0
          }
        },
        {
          field: 'news_groupss',
          label: '新闻日报推送群聊',
          component: 'GSelectGroup',
          componentProps: {
            placeholder: '请选择推送群聊',
          }
        },
        {
          field: 'time_groupss',
          label: '整点报时推送群聊',
          component: 'GSelectGroup',
          componentProps: {
            placeholder: '请选择推送群聊',
          }
        },
        {
          field: 'thumwhiteList',
          label: '骗赞推送群聊',
          component: 'GSelectGroup',
          componentProps: {
            placeholder: '请选择推送群聊',
          }
        },
        {
          label: '戳一戳配置',
          component: 'SOFT_GROUP_BEGIN'
        },
        {
          field: 'poke.enabled',
          label: '戳一戳总开关',
          bottomHelpMessage: '控制戳一戳功能的总开关',
          component: 'Switch'
        },
        {
          field: 'poke.priority',
          label: '戳一戳优先级',
          helpMessage: '设置戳一戳优先级，优先级越低越优先',
          component: 'InputNumber',
          componentProps: {
            defaultValue: -5000,
            bordered: true,
            autofocus: true,
            controls: true
          }
        },
        {
          label: '戳一戳模块开关',
          component: 'SOFT_GROUP_BEGIN'
        },
        {
          field: 'poke.modules.basic',
          label: '基础回复',
          component: 'Switch'
        },
        {
          field: 'poke.modules.mood',
          label: '心情系统',
          component: 'Switch'
        },
        {
          field: 'poke.modules.intimacy',
          label: '亲密度系统',
          component: 'Switch'
        },
        {
          field: 'poke.modules.achievement',
          label: '成就系统',
          component: 'Switch'
        },
        {
          field: 'poke.modules.special',
          label: '特殊效果',
          component: 'Switch'
        },
        {
          field: 'poke.modules.punishment',
          label: '惩罚系统',
          component: 'Switch'
        },
        {
          field: 'poke.modules.pokeback',
          label: '反戳系统',
          component: 'Switch'
        },
        {
          field: 'poke.modules.image',
          label: '图片发送',
          component: 'Switch'
        },
        {
          field: 'poke.modules.voice',
          label: '语音发送',
          component: 'Switch'
        },
        {
          field: 'poke.modules.master',
          label: '主人保护',
          component: 'Switch'
        },
        {
          label: '戳一戳功能配置',
          component: 'SOFT_GROUP_BEGIN'
        },
        {
          field: 'poke.pokeback_enabled',
          label: '机器人戳回功能',
          bottomHelpMessage: '是否启用机器人戳回功能（无法戳时关闭）',
          component: 'Switch'
        },
        {
          field: 'poke.image_chance',
          label: '发送图片概率',
          component: 'Slider',
          componentProps: {
            min: 0,
            max: 1,
            step: 0.01,
            defaultValue: 0.3
          }
        },
        {
          field: 'poke.voice_chance',
          label: '发送语音概率',
          component: 'Slider',
          componentProps: {
            min: 0,
            max: 1,
            step: 0.01,
            defaultValue: 0.2
          }
        },
        {
          field: 'poke.master_image',
          label: '戳主人时发送图片',
          component: 'Switch'
        },
        {
          field: 'poke.master_punishment',
          label: '惩罚戳主人的人',
          component: 'Switch'
        },
        {
          label: '戳一戳冷却时间',
          component: 'SOFT_GROUP_BEGIN'
        },
        {
          field: 'poke.cooldowns.interaction',
          label: '互动冷却（毫秒）',
          component: 'InputNumber',
          componentProps: {
            defaultValue: 30000,
            bordered: true,
            autofocus: true,
            controls: true,
            min: 0
          }
        },
        {
          field: 'poke.cooldowns.special_effect',
          label: '特效冷却（毫秒）',
          component: 'InputNumber',
          componentProps: {
            defaultValue: 180000,
            bordered: true,
            autofocus: true,
            controls: true,
            min: 0
          }
        },
        {
          field: 'poke.cooldowns.punishment',
          label: '惩罚冷却（毫秒）',
          component: 'InputNumber',
          componentProps: {
            defaultValue: 60000,
            bordered: true,
            autofocus: true,
            controls: true,
            min: 0
          }
        },
        {
          label: '戳一戳概率设置',
          component: 'SOFT_GROUP_BEGIN'
        },
        {
          field: 'poke.chances.mood_change',
          label: '心情变化概率',
          component: 'Slider',
          componentProps: {
            min: 0,
            max: 1,
            step: 0.01,
            defaultValue: 0.2
          }
        },
        {
          field: 'poke.chances.special_trigger',
          label: '特效触发概率',
          component: 'Slider',
          componentProps: {
            min: 0,
            max: 1,
            step: 0.01,
            defaultValue: 0.15
          }
        },
        {
          field: 'poke.chances.punishment',
          label: '惩罚概率',
          component: 'Slider',
          componentProps: {
            min: 0,
            max: 1,
            step: 0.01,
            defaultValue: 0.3
          }
        },
        {
          label: 'AI配置',
          component: 'SOFT_GROUP_BEGIN'
        },
        {
          field: 'peopleai',
          label: '人工AI开关',
          bottomHelpMessage: '开启后会自动打开词库ai，并非大模型ai',
          component: 'Switch'
        },
        {
          field: 'fncname',
          label: 'AI前缀',
          component: 'Input',
          componentProps: {
            placeholder: '请输入AI前缀',
          }
        },
        {
          field: 'selfcontrol',
          label: '自定义AI开关',
          bottomHelpMessage: '开启后才会显示AI相关配置选项，开启后保存记得刷新页面',
          component: 'Switch'
        },
        ...(cfg.merged.selfcontrol ? [
          {
            label: 'AI接口配置',
            component: 'SOFT_GROUP_BEGIN'
          },
          {
            field: 'ai.apiKey',
            label: 'API密钥',
            component: 'Input',
            componentProps: {
              placeholder: '请输入API密钥',
            }
          },
          {
            field: 'ai.baseUrl',
            label: '接口地址',
            component: 'Input',
            componentProps: {
              placeholder: '请输入接口地址',
            }
          },
          {
            field: 'ai.fileUploadUrl',
            label: '文件上传地址',
            component: 'Input',
            componentProps: {
              placeholder: '请输入文件上传地址',
            }
          },
          {
            field: 'ai.chatModel',
            label: '聊天模型',
            component: 'Input',
            componentProps: {
              placeholder: '请输入模型',
            }
          },
          {
            field: 'ai.visionModel',
            label: '识图模型',
            component: 'Input',
            componentProps: {
              placeholder: '请输入模型',
            }
          },
          {
            field: 'ai.max_tokens',
            label: '最大令牌',
            component: 'InputNumber',
            componentProps: {
              defaultValue: 6000,
              bordered: true,
              autofocus: true,
              controls: true
            }
          },
          {
            field: 'ai.temperature',
            label: '温度',
            component: 'Slider',
            componentProps: {
              min: 0,
              max: 1,
              step: 0.01
            }
          },
          {
            field: 'ai.top_p',
            label: 'Top P',
            component: 'Slider',
            componentProps: {
              min: 0,
              max: 1,
              step: 0.01
            }
          },
          {
            field: 'ai.presence_penalty',
            label: '存在惩罚',
            component: 'Slider',
            componentProps: {
              min: 0,
              max: 1,
              step: 0.01
            }
          },
          {
            field: 'ai.frequency_penalty',
            label: '频率惩罚',
            component: 'Slider',
            componentProps: {
              min: 0,
              max: 1,
              step: 0.01
            }
          },
          {
            label: 'AI触发配置',
            component: 'SOFT_GROUP_BEGIN'
          },
          {
            field: 'ai.triggerPrefix',
            label: '触发前缀',
            bottomHelpMessage: '空字符串表示需要@机器人',
            component: 'Input',
            componentProps: {
              placeholder: '请输入触发前缀，留空则需@机器人',
            }
          },
          {
            field: 'ai.historyLimit',
            label: '历史记录限制',
            bottomHelpMessage: '保留的对话历史条数',
            component: 'InputNumber',
            componentProps: {
              defaultValue: 10,
              bordered: true,
              autofocus: true,
              controls: true,
              min: 1,
              max: 100
            }
          },
          {
            field: 'ai.defaultPersona',
            label: '默认人设',
            component: 'Input',
            componentProps: {
              placeholder: '请输入默认人设',
              defaultValue: 'assistant'
            }
          },
          {
            label: 'AI白名单配置',
            component: 'SOFT_GROUP_BEGIN'
          },
          {
            field: 'ai.whitelist.groups',
            label: '白名单群聊',
            bottomHelpMessage: '允许使用AI的群聊列表',
            component: 'GSelectGroup',
            componentProps: {
              placeholder: '请选择白名单群聊',
            }
          },
          {
            field: 'ai.whitelist.users',
            label: '白名单用户',
            bottomHelpMessage: '允许使用AI的用户列表',
            component: 'GSelectFriend',
            componentProps: {
              placeholder: '请选择白名单用户',
            }
          },
          {
            field: 'ai.globalWhitelist',
            label: '全局白名单',
            bottomHelpMessage: '全局白名单群聊，选择允许使用AI的群聊',
            component: 'GSelectGroup',
            componentProps: {
              placeholder: '请选择全局白名单群聊',
            }
          },
          {
            label: '全局AI配置',
            component: 'SOFT_GROUP_BEGIN'
          },
          {
            field: 'ai.globalAIChance',
            label: '全局AI触发概率',
            bottomHelpMessage: '随机触发AI的概率（0-1之间）',
            component: 'Slider',
            componentProps: {
              min: 0,
              max: 1,
              step: 0.01,
              defaultValue: 0.05
            }
          },
          {
            field: 'ai.globalAICooldown',
            label: '全局AI冷却时间',
            bottomHelpMessage: '全局AI触发的冷却时间（秒）',
            component: 'InputNumber',
            componentProps: {
              defaultValue: 300,
              bordered: true,
              autofocus: true,
              controls: true,
              min: 0,
              max: 3600
            }
          }
        ] : []),
      ],

      getConfigData() {
        return cfg.merged;
      },
      
      setConfigData(data, {Result}) {
        let config = {};
        for (let [keyPath, value] of Object.entries(data)) {
          lodash.set(config, keyPath, value);
        }
        config = lodash.merge({}, cfg.merged, config);
        try {
          cfg.config.reader.setData(config);
          return Result.ok({}, '保存成功~');
        } catch (error) {
          return Result.error(`保存失败: ${error.message}`);
        }
      }
    }
  };
}