# 雨课堂 / 学堂在线 加密字体还原 破解复制脚本

油猴（Tampermonkey）脚本，将页面上的加密字体文字还原到可复制的浮窗中。当前脚本版本：1.9.1。

## 安装

1. 在浏览器中安装并启用 Tampermonkey 扩展。
2. [点击安装脚本](https://raw.githubusercontent.com/Delture/yuketang-decrypt/main/yuketang-decrypt.user.js)，在扩展的安装页面确认安装。
3. 打开或刷新雨课堂、学堂在线中含加密字体的页面。

若链接只显示源码，可在 Tampermonkey 中新建脚本，将本仓库的 `yuketang-decrypt.user.js` 全部内容粘贴并保存。

## 使用

- 检测到加密文字后，脚本会自动显示明文浮窗。
- 存疑字符会高亮，点击可切换候选字。
- 关闭浮窗后，可通过右下角“解密文本”按钮重新打开。
- 按住 Shift 点击该按钮，可清除缓存并重新识别。

## 实现与限制

脚本结合字体元数据解析、Canvas 字形比对和语境评分进行识别，并将映射保存在当前站点的 localStorage 中。常规字体匹配不足时，会尝试从公共 CDN 加载思源黑体参考字体。

支持的站点为 `yuketang.cn`、`xuetangx.com` 及其子域名。字体元数据解析支持 TTF、OTF、WOFF，暂不支持 WOFF2；无法直接解析时尝试视觉识别。结果可能存在误识别，请结合页面核对。

本次上传保留原始脚本，未进行真实站点功能验证。

## 许可

原脚本元数据标注作者为 WorkBuddy，许可证为 MIT；本仓库保留原有标注。
