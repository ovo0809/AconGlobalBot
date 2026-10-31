# 合成音视频测试资料

`synthetic-h264-aac.mp4` 用于 Windows 原生大视频准备集成测试。它由浏览器的 canvas、合成音调和 MediaRecorder 生成，不含客户文件、人声或外部素材；约六秒，H.264／AAC，76,698 bytes。SHA-256：`F5A9E5C3CB0C17A41EF87DA29F0256C52426CE371B0DB0B5D856EF82AB7940AA`。测试追加合法 ISO-BMFF `free` box 至 33 MiB，验证大文件分块与实际转码流程；这不是 33 MiB 有效视频内容、2 GB 文件或两小时压力测试。

`synthetic-audio-video.webm` 仅用于浏览器资料预处理回归。它由自动化测试环境生成，内容是 160×90 的双色画面、`SYNTHETIC TEST` 字样和 440 Hz 合成音，不含人声、客户资料或外部素材。

- 容器／编码：WebM，VP8／Opus
- 画面时长：约 3.036 秒
- 音轨时长：约 3.060 秒
- 音画差：约 0.024 秒
- SHA-256：`9B037D0523C1CDB4B83D0E55038B3E6B92528C6671C1E907E515749362DF8ACC`

时长由仓库锁定版本的 Playwright Chromium 实际读取并由 `AudioContext.decodeAudioData` 解码核对。测试仍通过真实浏览器读取文件、抽取画面和音轨，再上传到拦截的模拟 API；固定文件只消除运行时 `MediaRecorder` 受调度延迟影响导致的偶发音画偏差。
