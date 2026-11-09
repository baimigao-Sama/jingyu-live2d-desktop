# 鲸诺海 · 桌面 Live2D 形象

> 一只会跟着鼠标转头、摸哪都有反应、被冷落会委屈的 Windows 桌面 Live2D 桌宠。
> 不联网、不上传，模型和语音都在本机。

- 引擎：Electron + pixi-live2d-display（Cubism 4）
- 平台：Windows 10 / 11 x64
- 授权：PolyForm Noncommercial License 1.0.0（允许非商业使用、修改、分发；禁止商用）

---

## 她有什么

**形象**
- 真 Live2D 全参数驱动：呼吸、眨眼、单眼眨、尾巴 15 档情绪、裙摆摆动、身体倾斜
- 23 个语义表情 + 10 个模型预设（爱心眼 / 圈圈眼 / 流泪 / 脸红 / 黑脸…）
- 9 个模型自带动作组 + 18 个动作配方

**跟随**
- 头 18° 偏航 / 13° 侧倾 / 20° 前倾，身体横移 ±16px
- 眼快手慢：眼睛用原始坐标，头走 55ms 低通，头身走二阶弹簧
- 尾巴和裙后双手会晚半拍跟着身体

**互动**
- 9 个触摸分区：头 / 脖子 / 胸口 / 肚子 / 裙摆 / 手 / 脚 / 腿 / 尾巴
- 摸头有亲密度计数，摸得越多越耐摸（翻脸阈值 3→4→5 下）
- 8 秒内摸 6 下或覆盖 5 个分区 → 害羞 + 脸红 + 左顾右盼
- 快速绕头两圈 → 眩晕 → 嫌弃 → 黑脸；三连点会烦；尾巴是禁区

**记忆**
- 亲密度账本：累计 / 今天 / 最常摸哪 / 连续天数 / 上次时间
- 情绪账本：开心 2h、害羞 1h、不痛快 6h、委屈 6h、亲近 10 天，各有半衰期
- 被摸一下能把委屈当场清账；情绪够了会自己开口（25 分钟一次）

**桌面**
- 像素级智能穿透：只认角色像素，点空白直接落到下层窗口
- Alt + 拖动移位；可贴到指定窗口旁边跟着走
- 置顶、托盘、开机自启、窗口大小

**声音**
- 本地 TTS（可换音色）+ 音效；没有 TTS 时自动静音降级

**接口**
- MCP（`127.0.0.1:8768/mcp`，12 个工具）、本地 WebSocket（`3757`）、静态网页版（`3759`）

---

## 快速开始

### 方式一：直接用打包好的 exe（推荐）

1. 下载 `鲸诺海-桌面版.exe`
2. 双击运行。首次启动会解压到 `%TEMP%`，等 9–12 秒
3. 托盘图标可以切换「穿透 / 能摸她 / 退出」

> 需要 Windows 10 / 11 x64。Win7、ARM 版 Windows 不支持。

### 方式二：从源码运行（开发者）

```bash
# 需要 Node.js 20+
npm install
npm start
```

网页版：`npm run web`，浏览器打开 `http://127.0.0.1:3759/`。

**源码仓库不含以下两项（版权原因，需自备）：**

| 缺什么 | 怎么补 |
|---|---|
| Live2D 模型 | 放入 `models/deepseek/`，文件名与 `models/nono.model3.json` 对应 |
| Cubism Core | 从 Live2D 官网下载 `live2dcubismcore.min.js`，放入 `lib/` |

没有模型时程序会提示 `model_missing`；没有 Cubism Core 时页面白屏。

---

## 目录结构

```
js/          行为层（behavior.js）、互动层（interact.js）、情绪账本（mood.js）
desktop/     Electron 主进程、MCP 服务、预加载脚本、窗口辅助脚本
lib/         PixiJS / Cubism 运行时
models/      Live2D 模型（版权归原作者，见 THIRD-PARTY.txt）
recipes/     18 个动作配方（JSON）
strings/     台词库（144 句 / 28 场景）
tests/       自检脚本
build/       图标
index.html   渲染入口
```

---

## 配置与数据

- 配置：`%APPDATA%\nono-live2d-desktop\config.json`
- 日志：`%APPDATA%\nono-live2d-desktop\last-run.log`
- 点触记录：`%APPDATA%\nono-live2d-desktop\touch.jsonl`
- 情绪 / 亲密度：浏览器 localStorage（删掉即清零）

---

## 常见问题

**点她没反应？**
托盘 / 右键菜单切到「能摸她（Alt + 拖动移位）」。默认是穿透模式。

**想挪窗口？**
按住 `Alt` 再拖，平时点她只会互动。

**端口被占？**
控制端口会自动换（3757→3761，3759→3763）；MCP 固定 8768。

**没有声音？**
本机需要配置 edge-tts 或飞鱼语音服务；缺失时会静音，不影响本体。

**会不会偷看屏幕？**
不会截图、不上传。「感知前台窗口」只读进程名和窗口标题，且可在设置里关闭。

---

## 许可证

- 代码：**PolyForm Noncommercial License 1.0.0**，全文见 [LICENSE.txt](LICENSE.txt)
  - ✅ 非商业使用、修改、分发（分发须带上本许可和 `Required Notice:` 行）
  - ❌ 任何商业用途
- 模型与 Live2D Cubism Core 版权归各自作者，不在本许可内，见 [THIRD-PARTY.txt](THIRD-PARTY.txt)

```
Required Notice: Copyright (c) 2026 白米糕-Sama / 鲸诺海（鲸诺海 · 桌面 Live2D 形象 nono-live2d-desktop）
```

---

## 致谢

- 原画及拆分：**神宫凉子**
- Live2D 建模：**霓虹猫_NeonNeko**
- 行为设计参考：0 号（DSH-DS4）
- 部分交互思路参考：[dsh-desktop-petbox](https://github.com/HoppoChan0721/dsh-desktop-petbox)

如果你喜欢她，请也去支持模型的原作者。
