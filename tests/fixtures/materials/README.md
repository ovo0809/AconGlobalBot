# 合成音视频测试资料

`synthetic-audio-video.webm` 仅用于浏览器资料预处理回归。它由自动化测试环境生成，内容是 160×90 的双色画面、`SYNTHETIC TEST` 字样和 440 Hz 合成音，不含人声、客户资料或外部素材。

- 容器／编码：WebM，VP8／Opus
- 画面时长：约 3.036 秒
- 音轨时长：约 3.060 秒
- 音画差：约 0.024 秒
- SHA-256：`9B037D0523C1CDB4B83D0E55038B3E6B92528C6671C1E907E515749362DF8ACC`

时长由仓库锁定版本的 Playwright Chromium 实际读取并由 `AudioContext.decodeAudioData` 解码核对。测试仍通过真实浏览器读取文件、抽取画面和音轨，再上传到拦截的模拟 API；固定文件只消除运行时 `MediaRecorder` 受调度延迟影响导致的偶发音画偏差。
