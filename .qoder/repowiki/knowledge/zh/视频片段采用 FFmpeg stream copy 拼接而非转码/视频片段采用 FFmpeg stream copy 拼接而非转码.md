---
kind: design
name: 视频片段采用 FFmpeg stream copy 拼接而非转码
source: session
category: adr
---

# 视频片段采用 FFmpeg stream copy 拼接而非转码

_来源：deaa7e6 → c578ccd 提交周期内记录的编码计划——内容为规划时意图，实现可能滞后或有出入。_

**状态：** accepted

## 背景
Avatar 动画由 11 种预渲染的 .webm VP9 Alpha 切片组成，需要根据语义标签动态拼接并混入 TTS 音频。每次对话都要实时生成视频，性能是关键约束。

## 决策驱动
- 拼接速度（毫秒级）
- 画质无损（保持原始 VP9 Alpha）
- GPU 加速利用
- 资源占用最小化

## 备选方案
- **FFmpeg stream copy (-c:v copy -c:a libopus)** — 优点：无需重新编码，速度极快；保留 Alpha 透明通道；CPU/GPU 均可用；缺点：仅能拼接相同编解码器的片段；时长对齐需循环填充
- **逐帧转码拼接** _（已否决）_ — 优点：可统一分辨率/帧率；灵活性高；缺点：耗时数秒至数十秒；无法达到实时要求；Alpha 通道处理复杂
- **WebAssembly 浏览器端拼接** _（已否决）_ — 优点：减轻服务器压力；缺点：浏览器不支持 WebM VP9 Alpha 写入；移动端性能差；开发成本高

## 决策
使用 FFmpeg concat demuxer 以 stream copy 方式拼接 clips.toml 指定的 .webm 片段，末尾不足时循环填充（looping），TTS MP3 以 libopus 混入音轨；自动检测 GPU 编码器（Intel QSV / NVIDIA NVENC / CPU fallback）。

## 影响
单段拼接在 2-5ms 内完成，满足实时性要求；但所有切片必须预先转换为相同编解码参数，新增 convert_clips.py 预处理步骤；时长对齐依赖循环而非变速，可能导致视觉不连贯。