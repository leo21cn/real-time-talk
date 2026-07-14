/**
 * 形象视频组件
 *
 * - 双 <video> absolute 叠加架构：主视频 + 循环视频（idle/analysis）
 * - opacity 过渡消除黑闪
 * - 首段切换：等待 analysis 循环自然结束
 * - 客户端预缓存：所有 *.src 赋值前先尝试 IndexedDB 命中 → URL.createObjectURL
 */
import { useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react';
import { getCachedClipUrl } from '../services/clipCache';

export interface AvatarViewHandle {
  /** 播放指定 URL 的视频 */
  play: (url: string) => void;
  /** 切换到循环视频（idle/analysis） */
  playLoop: (src: string) => void;
  /** 停止所有视频 */
  stop: () => void;
  /** V10: 重置 AvatarView 内部状态（新会话开始时调用，避免上一轮 video src/warmup 残留） */
  reset: () => void;
  /** 当前主视频是否正在播放 */
  isPlaying: () => boolean;
  /** 获取 video 元素引用 */
  getVideoElement: () => HTMLVideoElement | null;
  /** V4: 预下载下一段视频到 blob 缓存，不切 video.src（让当前视频继续播） */
  preloadVideo: (url: string) => void;
  /** V4: 获取已预加载的 blob URL（如果有），并从缓存移除 */
  consumePreloadedBlob: (url: string) => string | null;
  /** V6: 预下载指定 URL 并返回 Promise<blobUrl>。resolve 时 blob 已就绪。 */
  preloadVideoAsync: (url: string) => Promise<string | null>;
  /** V9/V10: 提前把 blobUrl set 到空闲 video 元素上，触发浏览器异步解码。返回 Promise，resolve 时 idle video 元素 readyState >= 3（已可立即 play，无 canplay 等待）。 */
  warmupVideoElement: (blobUrl: string) => Promise<void>;
  /** V12: 仅清理 blob/warmup/preload 缓存（不动 video 元素 src/opacity），
   * 在新会话开始时调用，避免上一轮的 stale blob URL 干扰下一轮 warmup */
  clearPreloadedBlobs: () => void;
}

interface AvatarViewProps {
  /** 待机动画的 webm URL（默认/首选） */
  idleSrc?: string;
  /** 待机动画的 mp4 URL（移动端 fallback） */
  idleMp4Src?: string;
  /** thinking 分析动画的 webm URL（默认/首选） */
  analysisSrc?: string;
  /** thinking 分析动画的 mp4 URL（移动端 fallback） */
  analysisMp4Src?: string;
  /** 是否为移动端布局（控制高度） */
  isMobile?: boolean;
}

const AvatarView = forwardRef<AvatarViewHandle, AvatarViewProps>(
  function AvatarView(
    {
      idleSrc = '/api/clips/idle/idle_breathing.webm?v=10',
      idleMp4Src = '/api/clips/idle/idle_breathing.mp4?v=10',
      analysisSrc = '/api/clips/idle/idle_breathing.webm?v=11',
      analysisMp4Src = '/api/clips/idle/idle_breathing.mp4?v=11',
      isMobile = false,
    },
    ref
  ) {
    const mainVideoRef = useRef<HTMLVideoElement>(null);
    const loopVideoRef = useRef<HTMLVideoElement>(null);
    const pendingSrcRef = useRef<string | null>(null);
    const mainReadyRef = useRef(false); // 主视频是否已加载首帧
    const thinkingModeRef = useRef(false); // 是否处于思考模式（防止 segment_ready 竞态）
    const loopSwitchTimerRef = useRef<number | null>(null);
    const mainSwitchTimerRef = useRef<number | null>(null);
    const mainSrcClearTimerRef = useRef<number | null>(null);
    const bridgeFadeTimerRef = useRef<number | null>(null); // V25: 桥接涪出兑底定时器
    const activeElementRef = useRef<'main' | 'loop'>('loop'); // 当前可见的视频元素
    const loopIsSegmentRef = useRef(false); // loop 是否正在播放 segment（用于 ended 判断）
    const idleLoopActiveRef = useRef(false); // JS 手动接管 idle 无缝循环
    const loopMp4TriedRef = useRef(false); // loopVideo 是否已尝试 mp4 fallback（避免无限循环）
    const mainMp4TriedRef = useRef(false); // mainVideo 是否已尝试 mp4 fallback

    // 客户端预缓存：跟踪当前为每个 video 元素分配的 objectURL 及来源原始 URL
    // （原始 URL 用于错误兜底时判断加载哪个 mp4 变体 / 回退到 HTTP）
    const mainObjectUrlRef = useRef<string | null>(null);
    const loopObjectUrlRef = useRef<string | null>(null);
    const mainOriginalUrlRef = useRef<string | null>(null);
    const loopOriginalUrlRef = useRef<string | null>(null);

    // V4: 预下载缓存 — key 为原始 URL，value 为预创建的 objectURL。
    // segment_ready 后调用 preloadVideo 提前下载下一段视频，
    // video-ended 后从 consumePreloadedBlob 取出。
    const preloadedBlobsRef = useRef<Map<string, string>>(new Map());
    // V5: 正在重试预加载的 URL 集合（避免重复启动重试）
    const preloadPendingRef = useRef<Set<string> | null>(null);
    // V9: video 元素预热映射 — key 为 blobUrl，value 为该元素是 'main' 还是 'loop'。
    // 在段 N 视频播放期间调用 warmupVideoElement(blobUrl) 会把 blobUrl set 到空闲
    // video 元素上，浏览器异步解码；解码完成后段 N ended 时调用 showWarmedUpSegment
    // 可直接 opacity 切换（不走 canplay 等待），消除移动端 X5 内核 1-3s 解码停顿。
    const warmupMapRef = useRef<Map<string, 'main' | 'loop'>>(new Map());
    // V10: warmupPromiseMap — 每个 warmup 的 Promise，resolve 时 readyState >= 3。
    // video-ended 时 await 该 Promise 保证零停顿切换。
    const warmupPromiseMapRef = useRef<Map<string, Promise<void>>>(new Map());

    // 把 props 的 mp4 URL 同步到 ref，避免闭包问题
    const idleMp4Ref = useRef(idleMp4Src);
    const analysisMp4Ref = useRef(analysisMp4Src);
    idleMp4Ref.current = idleMp4Src;
    analysisMp4Ref.current = analysisMp4Src;

    /**
     * 客户端预缓存：把任意 URL（含 ?v=N 版本号）解析为 objectURL（如已缓存）或返回原 URL。
     * 异常时一律回退原 URL，确保不阻塞视频播放。
     */
    const resolveVideoSrc = useCallback(async (url: string): Promise<string> => {
      try {
        const cached = await getCachedClipUrl(url);
        return cached || url;
      } catch {
        return url;
      }
    }, []);

    /**
     * 应用已解析的 URL 到 video 元素：
     * - 撤销该元素上一次分配的 objectURL（避免内存泄露）
     * - 若新 src 是 blob: objectURL，记录以便下次撤销
     * - 可选：同时记录来源原始 URL（用于错误兜底）
     * - 同步赋值给 el.src
     */
    const assignVideoSrc = useCallback(
      (
        el: HTMLVideoElement,
        resolvedUrl: string,
        target: 'main' | 'loop',
        originalUrl?: string,
      ) => {
        const objRef = target === 'main' ? mainObjectUrlRef : loopObjectUrlRef;
        const origRef = target === 'main' ? mainOriginalUrlRef : loopOriginalUrlRef;
        if (objRef.current && objRef.current !== resolvedUrl) {
          try {
            URL.revokeObjectURL(objRef.current);
          } catch {
            /* ignore */
          }
          objRef.current = null;
        }
        const isObjectUrl = !!resolvedUrl && resolvedUrl.startsWith('blob:');
        if (isObjectUrl) {
          objRef.current = resolvedUrl;
        }
        if (originalUrl !== undefined) {
          origRef.current = originalUrl;
        }
        el.src = resolvedUrl;
      },
      [],
    );

    /** 主动撤销指定元素当前持有的 objectURL，同时清空原始 URL 记录 */
    const releaseVideoSrc = useCallback((target: 'main' | 'loop') => {
      const objRef = target === 'main' ? mainObjectUrlRef : loopObjectUrlRef;
      const origRef = target === 'main' ? mainOriginalUrlRef : loopOriginalUrlRef;
      if (objRef.current) {
        try {
          URL.revokeObjectURL(objRef.current);
        } catch {
          /* ignore */
        }
        objRef.current = null;
      }
      origRef.current = null;
    }, []);

    /**
     * 根据当前 loopVideo 的原始 URL 判断对应的 mp4 fallback URL。
     * 原始 URL 不受 objectURL 隐藏后缀影响，可靠性高。
     */
    const pickLoopMp4Fallback = useCallback((): string | null => {
      const originalSrc = loopOriginalUrlRef.current;
      if (!originalSrc) return null;
      // 当前已是 mp4，无需 fallback
      if (originalSrc.includes('.mp4')) return null;
      // 根据路径特征判断是 idle 还是 analysis
      if (originalSrc.includes('analysis')) return analysisMp4Ref.current;
      return idleMp4Ref.current;
    }, []);

    /** loopVideo 错误兜底：当前 src 加载失败时尝试 mp4 变体（仅一次） */
    const handleLoopError = useCallback(() => {
      if (loopMp4TriedRef.current) return;
      const loopVideo = loopVideoRef.current;
      if (!loopVideo) return;
      const fallback = pickLoopMp4Fallback();
      if (!fallback || fallback === loopVideo.src) return;
      console.warn('[AvatarView] loopVideo 加载失败，尝试 mp4 fallback:', fallback);
      loopMp4TriedRef.current = true;
      // 撤销当前可能持有的 objectURL，避免内存泄露
      releaseVideoSrc('loop');
      // fallback 也可能命中缓存，assignVideoSrc 会统一处理 objectURL 跟踪
      resolveVideoSrc(fallback).then((resolved) => {
        assignVideoSrc(loopVideo, resolved, 'loop', fallback);
        loopVideo.load();
      });
    }, [pickLoopMp4Fallback, assignVideoSrc, resolveVideoSrc]);

    /**
     * mainVideo 错误兜底（spec 风险 2）：objectURL 失效时回退到原始 HTTP URL。
     * 仅重试一次，避免无限循环。
     */
    const handleMainError = useCallback(() => {
      if (mainMp4TriedRef.current) return;
      const mainVideo = mainVideoRef.current;
      if (!mainVideo) return;
      const originalSrc = mainOriginalUrlRef.current;
      const currentSrc = mainVideo.src;
      // 当前是 objectURL 且有原始 URL 可兜底，尝试回退
      if (currentSrc.startsWith('blob:') && originalSrc && originalSrc !== currentSrc) {
        console.warn('[AvatarView] mainVideo objectURL 加载失败，回退到 HTTP:', originalSrc);
        mainMp4TriedRef.current = true;
        mainOriginalUrlRef.current = null;
        releaseVideoSrc('main');
        mainVideo.src = originalSrc;
        mainVideo.load();
      } else {
        console.warn('[AvatarView] mainVideo 加载失败:', currentSrc);
        mainMp4TriedRef.current = true;
      }
    }, [releaseVideoSrc]);

    /** 切换 src 时重置 mp4 fallback 状态 */
    const resetMp4Fallback = useCallback(() => {
      loopMp4TriedRef.current = false;
      mainMp4TriedRef.current = false;
    }, []);

    /** 清理切换定时器 */
    const clearLoopSwitchTimer = useCallback(() => {
      if (loopSwitchTimerRef.current) {
        window.clearTimeout(loopSwitchTimerRef.current);
        loopSwitchTimerRef.current = null;
      }
    }, []);

    const clearMainSwitchTimer = useCallback(() => {
      if (mainSwitchTimerRef.current) {
        window.clearTimeout(mainSwitchTimerRef.current);
        mainSwitchTimerRef.current = null;
      }
    }, []);

    const clearMainSrcClearTimer = useCallback(() => {
      if (mainSrcClearTimerRef.current) {
        window.clearTimeout(mainSrcClearTimerRef.current);
        mainSrcClearTimerRef.current = null;
      }
    }, []);

    /** 切换到主视频（双 video 交替预加载，消除段间空白帧） */
    // url 为已解析的 objectURL 或原始 HTTP URL；originalUrl 可选，记录来源用于错误兑底
    const showMain = useCallback((url: string, originalUrl?: string) => {
      const mainVideo = mainVideoRef.current;
      const loopVideo = loopVideoRef.current;
      if (!mainVideo || !loopVideo) return;

      clearMainSwitchTimer();
      clearMainSrcClearTimer();
      thinkingModeRef.current = false;
      idleLoopActiveRef.current = false;
      mainReadyRef.current = false;

      // 确定谁是当前可见的（旧帧）和谁将预加载新段
      const currentActive = activeElementRef.current;
      const targetEl = currentActive === 'main' ? loopVideo : mainVideo;
      const currentEl = currentActive === 'main' ? mainVideo : loopVideo;

      // 配置目标元素用于 segment 播放
      if (targetEl === loopVideo) {
        loopIsSegmentRef.current = true;
        loopVideo.style.transform = 'scale(1.7)';
        loopVideo.style.transformOrigin = 'center center';
        loopVideo.muted = true; // 先静音，等切换完成再取消静音
        loopVideo.volume = 1.0;
        loopVideo.loop = false;
      } else {
        loopIsSegmentRef.current = false;
        mainVideo.muted = true; // 先静音，等切换完成再取消静音
        mainVideo.volume = 1.0;
      }

      const switchToTarget = () => {
        if (mainReadyRef.current) return;
        mainReadyRef.current = true;
        clearMainSwitchTimer();

        // V15 修复（移动端 4G/5G 段落间闪烁）：保留 currentEl 最后一帧作为桥接，
        // 等 targetEl 真正开始播放（playing 事件触发）后再涪出 currentEl，
        // 避免在 targetEl 还未解码出首帧时同时隐藏旧帧 + 显示空白帧。
        // 允底超时 300ms：autoplay 被阻止/解码极慢时强制涪出 currentEl。
        const finalize = () => {
          // targetEl 立即可见（如果它已可显示首帧，用户立即看到）
          targetEl.style.transition = 'none';
          targetEl.style.opacity = '1';
          targetEl.style.pointerEvents = 'auto';
          // V11: play() 成功后延迟 unmute（确保 currentTime > 0 才允许声音）
          // 避免某些浏览器因 unmute 提前而阻止后续 play
          if (targetEl.currentTime > 0.05 || targetEl.readyState >= 2) {
            targetEl.muted = false;
          } else {
            const tryUnmute = () => {
              if (targetEl.currentTime > 0.05) {
                targetEl.muted = false;
                targetEl.removeEventListener('timeupdate', tryUnmute);
              } else {
                targetEl.addEventListener('timeupdate', tryUnmute);
              }
            };
            tryUnmute();
          }
          activeElementRef.current = currentActive === 'main' ? 'loop' : 'main';

          // V15: currentEl 涪出策略
          const fadeOutCurrent = () => {
            currentEl.style.transition = 'opacity 0.15s ease';
            currentEl.style.opacity = '0';
            currentEl.style.pointerEvents = 'none';
            window.setTimeout(() => {
              try { currentEl.pause(); } catch { /* ignore */ }
            }, 200);
          };
          // V32 修复：取消「!targetEl.paused && targetEl.currentTime > 0」快速涪出分支。
          // 原 V15 快速分支依赖于 play() 成功后的状态，但在 X5 微信 5G 慢网下
          // play().then() 回调时首帧可能还没真正渲染（解码延迟 100-500ms）。
          // 此期间淡出 currentEl + targetEl 还是空白 → 明显白屏闪现。
          // 统一走 V30 RVFC 首帧等待路径，最多等 1500ms（覆盖 5G 慢网）。
          let resolved = false;
          const onFirstFrame = () => {
            if (resolved) return;
            resolved = true;
            clearTimeout(hardFallback);
            targetEl.removeEventListener('playing', onPlaying);
            fadeOutCurrent();
          };
          // 优先：requestVideoFrameCallback 首帧回调（精确）
          const rvfc = (targetEl as any).requestVideoFrameCallback;
          if (typeof rvfc === 'function') {
            (targetEl as any).requestVideoFrameCallback(() => onFirstFrame());
          }
          // 兑底1：playing 事件 + 60ms 微等待（playing 后首帧可能还没画出来）
          const onPlaying = () => {
            targetEl.removeEventListener('playing', onPlaying);
            setTimeout(onFirstFrame, 60);
          };
          targetEl.addEventListener('playing', onPlaying);
          // 兑底2：硬超时 1500ms（原 300ms 不足以覆盖 5G 慢解码）
          const hardFallback = window.setTimeout(() => {
            targetEl.removeEventListener('playing', onPlaying);
            onFirstFrame();
          }, 1500);
        };

        // V13 修复：play() 可能被自动播放策略阻止（尤其当用户点击发送后一段时间才到下一段），
        // 这里采用“重试降级”策略：play() 失败后先 unmute 再重试（muted autoplay 通常不被拒，
        // 但有时会与之前的 unmute 状态冲突）；最终失败时保持 muted + 静态帧（V11 逻辑）。
        const attemptPlay = (attempt: number): void => {
          // 第一次 muted 试播（Chrome / Safari 均允许 muted autoplay）
          if (attempt === 1) {
            targetEl.muted = true;
          }
          targetEl.play().then(() => {
            finalize();
          }).catch((err) => {
            if (attempt === 1) {
              // 第二次重试：保持 muted 但重新加载源（某些浏览器需要重新 load 才能修复状态）
              console.warn('play() 被阻止 (attempt 1)，重试中...:', err.name);
              try { targetEl.load(); } catch { /* ignore */ }
              window.setTimeout(() => attemptPlay(2), 80);
            } else if (attempt === 2) {
              // 第三次重试：延迟 200ms（希望用户手势上下文重新生效）
              console.warn('play() 被阻止 (attempt 2)，延迟重试:', err.name);
              window.setTimeout(() => attemptPlay(3), 200);
            } else {
              // 最终失败：保持 muted + 显示首帧（V11 降级逻辑）
              console.warn('play() 最终失败，降级切换（保持 muted）:', err.name);
              finalize();
            }
          });
        };
        attemptPlay(1);
      };

      // 预加载新段到目标元素（先尝试 IndexedDB 命中 → objectURL，避免回源）
      assignVideoSrc(
        targetEl,
        url,
        targetEl === mainVideo ? 'main' : 'loop',
        originalUrl,
      );

      // V2: 发送埋点事件 (avatar-src-set)
      window.dispatchEvent(
        new CustomEvent('avatar-src-set', {
          detail: {
            url: url,
            originalUrl: originalUrl || url,
            target: targetEl === mainVideo ? 'main' : 'loop',
            ts: performance.now(),
          },
        }),
      );

      // canplay 后立即播放（静音），等待首帧渲染
      const onCanPlay = () => {
        targetEl.removeEventListener('canplay', onCanPlay);
        // V2: 发送 canplay 事件
        window.dispatchEvent(
          new CustomEvent('avatar-canplay', {
            detail: {
              url: url,
              originalUrl: originalUrl || url,
              target: targetEl === mainVideo ? 'main' : 'loop',
              ts: performance.now(),
            },
          }),
        );
        switchToTarget();
      };
      targetEl.addEventListener('canplay', onCanPlay);

      if (targetEl.readyState >= 3) {
        targetEl.removeEventListener('canplay', onCanPlay);
        switchToTarget();
      }

      // V28: 超时从 800ms 延长至 5000ms，适配 5G 移动网络下 segment 下载耗时（1-2s）。
      // 800ms 在 5G 下早于 canplay 触发，导致 mainVideo 无帧数据时被设为可见、
      // loopVideo 同时被隐藏 → 卡通形象消失 1-2s。5000ms 覆盖 5G 场景，
      // canplay 自然先于超时触发完成正常切换。WiFi 下 canplay<200ms 不受影响。
      mainSwitchTimerRef.current = window.setTimeout(() => {
        if (!mainReadyRef.current) {
          switchToTarget();
        }
      }, 5000);
    }, [clearMainSwitchTimer, clearMainSrcClearTimer, assignVideoSrc]);

    // src 为已解析的 objectURL 或原始 HTTP URL；originalSrc 可选，记录来源用于错误兑底
    const showLoop = useCallback((src?: string, originalSrc?: string) => {
      const mainVideo = mainVideoRef.current;
      const loopVideo = loopVideoRef.current;
      if (!mainVideo || !loopVideo) return;

      clearLoopSwitchTimer();
      // V25: 清理上一次的桥接涪出兑底定时器
      if (bridgeFadeTimerRef.current) {
        window.clearTimeout(bridgeFadeTimerRef.current);
        bridgeFadeTimerRef.current = null;
      }
      loopIsSegmentRef.current = false;

      // 判断是否为 idle 模式
      const isIdle = !src || !src.includes('analysis');

      // speaking→idle 时 loopVideo 带有 scale(1.7)，保持当前可见视频桥接避免空白闪烁
      // idle→analysis 切换时 keep idle 帧可见，利用浏览器最后一帧缓存消除闪烁
      const loopHasScale = loopVideo.style.transform.includes('scale(1.7)');
      let mainIsBridge = false; // mainVideo 是否作为桥接（保持可见）
      if (loopHasScale) {
        if (activeElementRef.current === 'main') {
          // mainVideo 当前可见 → 只隐藏 loopVideo（带 scale），mainVideo 保持桥接
          loopVideo.pause();
          loopVideo.style.transition = 'none';
          loopVideo.style.opacity = '0';
          loopVideo.style.pointerEvents = 'none';
          mainIsBridge = true;
        } else {
          // loopVideo 当前可见但带 scale → 检查 mainVideo 是否有可用内容
          const mainHasContent = mainVideo.src && mainVideo.readyState >= 1;
          loopVideo.style.transition = 'none';
          loopVideo.style.opacity = '0';
          loopVideo.style.pointerEvents = 'none';
          loopVideo.pause();
          if (mainHasContent) {
            // mainVideo 有内容 → 作为桥接
            mainVideo.style.transition = 'none';
            mainVideo.style.opacity = '1';
            mainVideo.style.pointerEvents = 'auto';
            mainIsBridge = true;
          } else {
            // mainVideo 无内容 → 回退：保持 loopVideo 可见（带 scale 好过空白）
            loopVideo.style.opacity = '1';
            loopVideo.style.pointerEvents = 'auto';
            mainIsBridge = false;
          }
        }
      } else {
        // V10 修复：标准路径（segment→idle）不要立即隐藏 mainVideo，
        // 让 mainVideo 作为桥接保持可见，等 loopVideo idle canplay 后再淡出。
        // 原因：移动端 loopVideo 加载 idle webm/mp4 需要 1-3s，
        // 期间 mainVideo opacity=0 + loopVideo opacity=0 会导致卡通形象消失。
        const mainHasContent = mainVideo.src && mainVideo.readyState >= 1;
        if (activeElementRef.current === 'main' && mainHasContent) {
          // mainVideo 当前可见且有内容 → 作为桥接
          mainVideo.pause();
          mainVideo.style.transition = 'none';
          mainVideo.style.opacity = '1';
          mainVideo.style.pointerEvents = 'auto';
          mainIsBridge = true;
        } else {
          // mainVideo 不在 active 或无内容 → 隐藏
          mainVideo.pause();
          mainVideo.style.transition = 'none';
          mainVideo.style.opacity = '0';
          mainVideo.style.pointerEvents = 'none';
        }
      }

      clearMainSrcClearTimer();
      // mainVideo 作为桥接时不在此清除 src，等 loopVideo 就绪后再清除
      if (!mainIsBridge) {
        mainSrcClearTimerRef.current = window.setTimeout(() => {
          mainSrcClearTimerRef.current = null;
          releaseVideoSrc('main');
          mainVideo.src = '';
          mainVideo.load();
        }, 150);
      }

      // 重置 loop 样式为 loop 模式
      loopVideo.style.transform = '';
      loopVideo.style.transformOrigin = '';
      loopVideo.muted = true;

      if (isIdle) {
        // idle：JS 接管无缝循环
        loopVideo.loop = false;
        idleLoopActiveRef.current = true;
      } else {
        // analysis：原生 loop 循环播放（onLoopTimeUpdate 检查 pending 段触发切换）
        loopVideo.loop = true;
        idleLoopActiveRef.current = false;
      }

      // 比较基础路径（忽略查询参数），避免 idle↔analysis 同文件重复加载导致空白帧
      // V27: 使用 loopOriginalUrlRef 而非 getAttribute('src') 进行路径比较。
      // 当 idle 视频从 IndexedDB 缓存加载时，getAttribute('src') 返回 blob: URL，
      // 与新的 HTTP URL 永远不匹配，导致错误地触发 src 切换 → 网络重新加载 →
      // 移动端 4G/5G 慢网下 loopVideo 无帧可显示，卡通形象消失 ~1s。
      // 参考：loopOriginalUrlRef 记录了原始 HTTP URL，即使当前 src 是 blob 也正确。
      const currentSrc = loopOriginalUrlRef.current || loopVideo.getAttribute('src');
      const currentBase = currentSrc ? currentSrc.split('?')[0] : '';
      const newBase = src ? src.split('?')[0] : '';
      if (src && currentBase !== newBase) {
        if (!loopHasScale && !isIdle) {
          // idle→analysis：keep 当前帧，直接设新 src（不清除旧数据）
          const onLoopReady = () => {
            loopVideo.removeEventListener('canplay', onLoopReady);
            clearLoopSwitchTimer();
            loopVideo.currentTime = 0;
            loopVideo.style.transition = 'none';
            loopVideo.style.opacity = '1';
            loopVideo.style.pointerEvents = 'auto';
            loopVideo.play().catch(() => {});
          };
          loopVideo.addEventListener('canplay', onLoopReady);
          assignVideoSrc(loopVideo, src, 'loop', originalSrc);
          if (loopVideo.readyState >= 3) {
            onLoopReady();
          }
          loopSwitchTimerRef.current = window.setTimeout(() => {
            if (loopVideo.style.opacity !== '1') {
              onLoopReady();
            }
          }, 800);
        } else {
          // 其他切换（含 scale 重置后）
          if (loopHasScale && !mainIsBridge) {
            // 特例：loopVideo 作为临时桥接（mainVideo 无内容）
            // 在 mainVideo 预加载 idle，避免清除 loopVideo 导致空白帧
            // 临时移除 mainVideo 内联 scale(1.7)，idle 不应缩放
            mainVideo.style.transform = '';
            mainVideo.style.transformOrigin = '';
            mainVideo.muted = true;
            mainVideo.loop = isIdle ? false : true;

            const onMainReady = () => {
              mainVideo.removeEventListener('canplay', onMainReady);
              clearLoopSwitchTimer();
              mainVideo.currentTime = 0;
              // 交叉淡入淡出：loopVideo → mainVideo（同帧过渡，避免空白）
              loopVideo.style.transition = 'opacity 0.15s ease';
              loopVideo.style.opacity = '0';
              loopVideo.style.pointerEvents = 'none';
              loopVideo.pause();
              mainVideo.style.transition = 'opacity 0.15s ease';
              mainVideo.style.opacity = '1';
              mainVideo.style.pointerEvents = 'auto';
              mainVideo.play().catch(() => {});
              activeElementRef.current = 'main';

              // 清除 loopVideo 旧 segment 数据
              releaseVideoSrc('loop');
              loopVideo.removeAttribute('src');
              loopVideo.load();

              // 后台加载 idle 到 loopVideo，就绪后切回正常循环
              const switchBackToLoop = () => {
                assignVideoSrc(loopVideo, src, 'loop', originalSrc);
                const onLoopReady = () => {
                  loopVideo.removeEventListener('canplay', onLoopReady);
                  // 交叉淡化：mainVideo 淡出 + loopVideo 淡入
                  mainVideo.style.transition = 'opacity 0.15s ease';
                  mainVideo.style.opacity = '0';
                  mainVideo.style.pointerEvents = 'none';
                  mainVideo.pause();
                  loopVideo.style.transition = 'opacity 0.15s ease';
                  loopVideo.style.opacity = '1';
                  loopVideo.style.pointerEvents = 'auto';
                  loopVideo.play().catch(() => {});
                  activeElementRef.current = 'loop';
                  // 恢复 mainVideo 内联 scale，延迟清除 src
                  mainVideo.style.transform = 'scale(1.7)';
                  mainVideo.style.transformOrigin = 'center center';
                  clearMainSrcClearTimer();
                  window.setTimeout(() => {
                    releaseVideoSrc('main');
                    mainVideo.src = '';
                    mainVideo.load();
                  }, 200);
                };
                loopVideo.addEventListener('canplay', onLoopReady);
                if (loopVideo.readyState >= 3) onLoopReady();
                loopSwitchTimerRef.current = window.setTimeout(() => {
                  if (loopVideo.style.opacity !== '1') onLoopReady();
                }, 800);
              };
              window.setTimeout(switchBackToLoop, 200);
            };

            mainVideo.addEventListener('canplay', onMainReady);
            assignVideoSrc(mainVideo, src, 'main', originalSrc);
            if (mainVideo.readyState >= 3) onMainReady();
            loopSwitchTimerRef.current = window.setTimeout(() => {
              if (mainVideo.style.opacity !== '1') onMainReady();
            }, 800);
          } else {
            // V11 修复：标准路径保留 loopVideo 当前帧作为桥接，
            // 不立即隐藏 loopVideo（避免“hi 后 1-2s 空白”和移动端每段闪烁）。
            // 逻辑：保留 loopVideo.opacity 不动（仍显示 idle 帧），
            // 设新 src 等 canplay 后播放新 src（视频元素自动渲染新帧）。
            // 如果 mainVideo 是桥接（segment→idle 切换），等 loopVideo 真正在播后
            // 再淡出 mainVideo，避免空白。

            // 强制 reflow（确保设 src 前 layout 是稳定的）
            void loopVideo.offsetHeight;

            let bridgeCanplayFired = false;
            const onLoopReady = () => {
              loopVideo.removeEventListener('canplay', onLoopReady);
              clearLoopSwitchTimer();
              loopVideo.currentTime = 0;
              // V11: 确保 loopVideo 显示，不立即设 opacity=0
              loopVideo.style.transition = 'none';
              loopVideo.style.opacity = '1';
              loopVideo.style.pointerEvents = 'auto';
              // 如果 mainVideo 是桥接（segment→idle），等 loopVideo 真正开始播后再涪出 mainVideo
              if (mainIsBridge) {
                // V25/V26: 定时器兑底，等 loopVideo 真正有可见数据才淡出 mainVideo，
                // 避免两者同时 opacity=0 露出白色容器背景（X5 内核 canplay 慢导致 1s 白闪）
                let bridgeFadedOut = false;
                const forceFadeOut = () => {
                  if (bridgeFadedOut) return;
                  // V26: 等 loopVideo 真正有可见数据才淡出 mainVideo，避免白闪
                  if (!bridgeCanplayFired || (loopVideo.readyState < 2 && loopVideo.videoWidth === 0)) {
                    window.setTimeout(forceFadeOut, 200);
                    return;
                  }
                  bridgeFadedOut = true;
                  clearMainSrcClearTimer();
                  mainVideo.pause();
                  mainVideo.style.transition = 'opacity 0.15s ease';
                  mainVideo.style.opacity = '0';
                  mainVideo.style.pointerEvents = 'none';
                  window.setTimeout(() => {
                    releaseVideoSrc('main');
                    mainVideo.src = '';
                    mainVideo.load();
                  }, 200);
                };
                const onCanPlayForBridge = () => {
                  bridgeCanplayFired = true;
                };
                loopVideo.addEventListener('canplay', onCanPlayForBridge, { once: true });
                const checkMainFadeOut = () => {
                  if (loopVideo.currentTime > 0.05 || loopVideo.readyState >= 3) {
                    forceFadeOut();
                  } else {
                    loopVideo.addEventListener('timeupdate', checkMainFadeOut, { once: true });
                  }
                };
                checkMainFadeOut();
                // V26: 兑底延长到 2s（之前 500ms 在 X5 上引起白闪）
                bridgeFadeTimerRef.current = window.setTimeout(() => forceFadeOut(), 2000);
              }
              loopVideo.play().catch(() => {});
            };
            loopVideo.addEventListener('canplay', onLoopReady);
            // 不释放旧 src（保留当前帧作为桥接）—— V11 修复
            assignVideoSrc(loopVideo, src, 'loop', originalSrc);
            if (loopVideo.readyState >= 3) {
              onLoopReady();
            }
            // 兜底 800ms
            loopSwitchTimerRef.current = window.setTimeout(() => {
              if (loopVideo.style.opacity !== '1') {
                onLoopReady();
              }
            }, 800);
          }
        }
      } else if (!src) {
        // 无 src 参数：保持当前 idle 循环
        loopVideo.loop = false;
        idleLoopActiveRef.current = true;
        loopVideo.style.opacity = '1';
        loopVideo.style.pointerEvents = 'auto';
        // 隐藏桥接的 mainVideo
        if (mainIsBridge) {
          clearMainSrcClearTimer();
          mainVideo.pause();
          mainVideo.style.transition = 'none';
          mainVideo.style.opacity = '0';
          mainVideo.style.pointerEvents = 'none';
        }
        loopVideo.play().catch(() => {});
      } else {
        // src 相同，直接显示（保持 idle 循环或 analysis）
        const isSameIdle = !src.includes('analysis');
        loopVideo.loop = isSameIdle ? false : true;
        idleLoopActiveRef.current = isSameIdle;
        loopVideo.style.opacity = '1';
        loopVideo.style.pointerEvents = 'auto';
        loopVideo.currentTime = 0;
        // 隐藏桥接的 mainVideo
        if (mainIsBridge) {
          clearMainSrcClearTimer();
          mainVideo.pause();
          mainVideo.style.transition = 'none';
          mainVideo.style.opacity = '0';
          mainVideo.style.pointerEvents = 'none';
        }
        loopVideo.play().catch(() => {});
      }

      activeElementRef.current = 'loop';
    }, [clearLoopSwitchTimer, clearMainSrcClearTimer, assignVideoSrc, releaseVideoSrc]);

    // 暴露方法给父组件
    useImperativeHandle(ref, () => ({
      async play(url: string) {
        const loopVideo = loopVideoRef.current;
        if (!loopVideo) return;

        // 切换主视频源时重置 mp4 fallback 状态
        resetMp4Fallback();

        // V4: 优先使用预下载的 blob（如果之前已 preloadVideo 过）
        const preloaded = preloadedBlobsRef.current.get(url);
        if (preloaded) {
          preloadedBlobsRef.current.delete(url);
          // V26: 移除 thinkingModeRef pending 逻辑，立即 showMain
          pendingSrcRef.current = null;
          showMain(preloaded, url);
          return;
        }

        // V26: 移除 thinkingModeRef pending 逻辑，立即 resolve 后 showMain
        pendingSrcRef.current = null;
        const resolved = await resolveVideoSrc(url);
        showMain(resolved, url);
      },

      // V4: 预下载下一段视频到 blob 缓存。不切 video.src，
      // 让当前视频继续播。video-ended 后用 consumePreloadedBlob 取出。
      // V5: 加重试机制 — 段 N+1 可能还没 ready（服务端生成中），
      // fetch 会 404，每 200ms 重试一次，直到 blob 就绪。
      // V6: 抽出 _fetchAndCacheBlob 供 preloadVideo 和 preloadVideoAsync 共用。
      preloadVideo(url: string) {
        // 启动后台 fetch，不关心结果（fire-and-forget）
        this.preloadVideoAsync(url).catch(() => { /* ignore */ });
      },

      // V6: 返回 Promise。resolve 时 blob 已就绪（在缓存中）。
      // 用于 video-ended 时 await buffer 中的预加载，立即获得 blob URL。
      preloadVideoAsync(url: string): Promise<string | null> {
        if (preloadedBlobsRef.current.has(url)) {
          return Promise.resolve(preloadedBlobsRef.current.get(url)!);
        }
        // 限制缓存数量，避免内存爆炸（仅保留最近 5 段预下载）
        if (preloadedBlobsRef.current.size >= 5) {
          const firstKey = preloadedBlobsRef.current.keys().next().value;
          if (firstKey) {
            const oldObjUrl = preloadedBlobsRef.current.get(firstKey);
            if (oldObjUrl) {
              try { URL.revokeObjectURL(oldObjUrl); } catch { /* ignore */ }
            }
            preloadedBlobsRef.current.delete(firstKey);
          }
        }
        // 记录正在预加载的 URL（用于取消重试）
        const pendingSet = (preloadPendingRef.current ||= new Set<string>());
        if (pendingSet.has(url)) {
          // 已经有重试在进行中，返回一个会等待的 Promise
          return new Promise((resolve) => {
            const check = () => {
              if (preloadedBlobsRef.current.has(url)) {
                resolve(preloadedBlobsRef.current.get(url)!);
              } else if (!pendingSet.has(url)) {
                resolve(null); // 超时
              } else {
                window.setTimeout(check, 200);
              }
            };
            check();
          });
        }
        pendingSet.add(url);

        return new Promise<string | null>((resolve) => {
          let attempt = 0;
          const maxAttempts = 150; // 200ms * 150 = 30秒
          let settled = false;
          const tryOnce = (): void => {
            if (settled) return;
            // 已被 consume（被 play 用掉）则停止重试
            if (!pendingSet.has(url)) {
              settled = true;
              resolve(preloadedBlobsRef.current.get(url) ?? null);
              return;
            }
            fetch(url, { credentials: 'same-origin' })
              .then((resp) => {
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                return resp.blob();
              })
              .then((blob) => {
                if (settled) return;
                settled = true;
                // 完成：从 pending 集合移除、存为 blob
                pendingSet.delete(url);
                if (preloadedBlobsRef.current.has(url)) {
                  URL.revokeObjectURL(preloadedBlobsRef.current.get(url)!);
                }
                const objUrl = URL.createObjectURL(blob);
                preloadedBlobsRef.current.set(url, objUrl);
                resolve(objUrl);
              })
              .catch((err) => {
                attempt += 1;
                if (attempt >= maxAttempts || !pendingSet.has(url)) {
                  pendingSet.delete(url);
                  if (!settled) {
                    settled = true;
                    if (attempt >= maxAttempts) {
                      console.warn('[AvatarView] preloadVideo max retries reached:', url);
                    }
                    resolve(null);
                  }
                  return;
                }
                // 200ms 后重试
                window.setTimeout(tryOnce, 200);
              });
          };
          tryOnce();
        });
      },

      // V4: 消费预下载的 blob。返回 objectURL（如果有），并从缓存移除。
      // 调用者负责使用后 revoke（由 AvatarView 内部 assignVideoSrc 统一处理）。
      consumePreloadedBlob(url: string): string | null {
        const objUrl = preloadedBlobsRef.current.get(url);
        if (objUrl) {
          preloadedBlobsRef.current.delete(url);
          return objUrl;
        }
        return null;
      },

      // V9/V10: 提前把 blobUrl set 到空闲 video 元素上，触发浏览器异步解码。
      // V10: 返回 Promise<void>，resolve 时 idle video 元素 readyState >= 3
      // （已可立即 play，无 canplay 等待）。
      // 背景：之前的实现是“video-ended 时才 play(blobUrl)”，此时 video 元素需要
      // 重新解码（X5 内核 1-3s）。本方法在段 N 播放期间就把段 N+1 设为空闲 video
      // 元素的 src，让浏览器后台解码；ended 后只需 opacity 切换即可，零停顿。
      // V10 修复：以前返回 void，video-ended 时只能依赖 showMain 的 readyState 检查
      // （依赖时序巧合）。现在 await Promise 保证 readyState 已达 >= 3，绝对零停顿。
      warmupVideoElement(blobUrl: string): Promise<void> {
        // 已 warmup 过且解码完成 → 直接 resolve
        const existing = warmupMapRef.current.get(blobUrl);
        if (existing) {
          const existingPromise = warmupPromiseMapRef.current.get(blobUrl);
          if (existingPromise) {
            return existingPromise;
          }
        }

        const mainVideo = mainVideoRef.current;
        const loopVideo = loopVideoRef.current;
        if (!mainVideo || !loopVideo) return Promise.resolve();

        // 选取空闲 video 元素：active 那个是可见的，另一个是空闲的
        const idleEl = activeElementRef.current === 'main' ? loopVideo : mainVideo;
        const idleTarget: 'main' | 'loop' = idleEl === mainVideo ? 'main' : 'loop';

        // 如果空闲元素已经加载了同一 blobUrl 且 readyState >= 3，直接 resolve
        if (idleEl.src === blobUrl && idleEl.readyState >= 3) {
          warmupMapRef.current.set(blobUrl, idleTarget);
          return Promise.resolve();
        }

        // 释放旧 src（避免内存泄漏、避免 prev 段残留干扰）
        releaseVideoSrc(idleTarget);
        // 立即设新 src（开始异步解码）
        assignVideoSrc(idleEl, blobUrl, idleTarget, blobUrl);
        // 记录 warmup
        warmupMapRef.current.set(blobUrl, idleTarget);

        // V10: 返回 Promise，等 canplay 后 resolve
        const warmupPromise = new Promise<void>((resolve) => {
          let resolved = false;
          const onCanPlay = () => {
            if (resolved) return;
            resolved = true;
            idleEl.removeEventListener('canplay', onCanPlay);
            idleEl.removeEventListener('error', onError);
            resolve();
          };
          const onError = () => {
            if (resolved) return;
            resolved = true;
            idleEl.removeEventListener('canplay', onCanPlay);
            idleEl.removeEventListener('error', onError);
            console.warn('[AvatarView] warmup canplay error, blobUrl:', blobUrl);
            resolve(); // 即使错误也 resolve，让调用方走 fallback
          };
          idleEl.addEventListener('canplay', onCanPlay, { once: true });
          idleEl.addEventListener('error', onError, { once: true });
          // 兜底：8s 内未 canplay，强制 resolve（避免永远等）
          window.setTimeout(() => {
            if (resolved) return;
            resolved = true;
            idleEl.removeEventListener('canplay', onCanPlay);
            idleEl.removeEventListener('error', onError);
            resolve();
          }, 8000);
        });
        warmupPromiseMapRef.current.set(blobUrl, warmupPromise);
        return warmupPromise;
      },

      async playLoop(src: string) {
        // 切换循环视频源时重置 mp4 fallback 状态
        resetMp4Fallback();
        // 更新思考模式标志（用原始 URL 判断，避免 objectURL 丢掉特征）
        thinkingModeRef.current = src.includes('analysis');
        // 如果从 analysis 切走，取消待播放的 segment
        if (!src.includes('analysis')) {
          pendingSrcRef.current = null;
        }
        const resolved = await resolveVideoSrc(src);
        showLoop(resolved, src);
      },

      stop() {
        clearMainSrcClearTimer();
        // V25: 清理桥接涪出兑底定时器
        if (bridgeFadeTimerRef.current) {
          window.clearTimeout(bridgeFadeTimerRef.current);
          bridgeFadeTimerRef.current = null;
        }
        const mainVideo = mainVideoRef.current;
        const loopVideo = loopVideoRef.current;
        if (mainVideo) {
          mainVideo.pause();
          mainVideo.style.opacity = '0';
          mainVideo.style.pointerEvents = 'none';
        }
        if (loopVideo) {
          loopVideo.pause();
        }
      },

      // V10/V11: 重置 AvatarView 内部状态（新会话开始时调用，避免上一轮 video src/warmup 残留）。
      // V11 修复：不动 video 元素的 opacity（保持当前帧可见），
      // 让 playLoop(analysis) 接管过渡动画，避免“hi 后 1-2s 空白”问题。
      // - 清 preloadedBlobsRef（避免上一轮 blob URL 残留）
      // - 清 warmupMapRef / warmupPromiseMapRef（避免对老 blobUrl 走快速路径）
      // - 清 video 元素 src（但不设 opacity=0）
      // - 清 thinkingModeRef / pendingSrcRef
      reset() {
        // V25: 清理桥接涪出兑底定时器
        if (bridgeFadeTimerRef.current) {
          window.clearTimeout(bridgeFadeTimerRef.current);
          bridgeFadeTimerRef.current = null;
        }
        // 清 blob URL 缓存
        preloadedBlobsRef.current.forEach((objUrl) => {
          try { URL.revokeObjectURL(objUrl); } catch { /* ignore */ }
        });
        preloadedBlobsRef.current.clear();
        // 清 warmup 状态
        warmupMapRef.current.clear();
        warmupPromiseMapRef.current.clear();
        // 清 pending retry 集合（preloadVideoAsync 内部使用）
        if (preloadPendingRef.current) {
          preloadPendingRef.current.clear();
        }
        // 清 video 元素 src（但不设 opacity=0 — 保留当前帧作为 playLoop 过渡的桥接）
        releaseVideoSrc('main');
        releaseVideoSrc('loop');
        const mainVideo = mainVideoRef.current;
        const loopVideo = loopVideoRef.current;
        if (mainVideo) {
          mainVideo.removeAttribute('src');
          mainVideo.load();
          // V11: 不动 opacity — 保持当前帧可见
        }
        if (loopVideo) {
          loopVideo.removeAttribute('src');
          loopVideo.load();
          // V11: 不动 opacity — 保持当前帧可见
        }
        // 清状态 ref
        thinkingModeRef.current = false;
        pendingSrcRef.current = null;
        mainReadyRef.current = false;
        idleLoopActiveRef.current = false;
        loopIsSegmentRef.current = false;
        // 不重置 activeElementRef（让 playLoop 决定）
        // 清 mp4 fallback 状态
        resetMp4Fallback();
      },

      isPlaying() {
        const mainVideo = mainVideoRef.current;
        return mainVideo ? !mainVideo.paused : false;
      },

      getVideoElement() {
        return mainVideoRef.current;
      },

      // V12: 仅清理 blob/warmup/preload 缓存（不动 video 元素 src/opacity），
      // 避免上一轮的 stale blob URL 被新一轮 warmup 错误复用，导致卡通形象误播上一轮内容。
      clearPreloadedBlobs() {
        // 仅清 Map（不 revoke 对象 URL），避免中断当前 video 元素正在使用的 blob。
        // 新会话的 preloadVideoAsync 会重新创建 blob 并写入 Map。
        preloadedBlobsRef.current.clear();
        // 清 warmup 状态：防止对老 blobUrl 走“已解码完成”快速路径
        warmupMapRef.current.clear();
        warmupPromiseMapRef.current.clear();
        // 清 pending retry 集合
        if (preloadPendingRef.current) {
          preloadPendingRef.current.clear();
        }
      },
    }), [showMain, showLoop, resetMp4Fallback, resolveVideoSrc, releaseVideoSrc, assignVideoSrc]);

    // 主视频播放完毕回调
    const onMainEnded = useCallback(() => {
      window.dispatchEvent(new CustomEvent('video-ended'));
    }, []);

    // 循环视频 ended 回调：segment 结束通知父组件；idle 兜底 seek(0) 重播
    const onLoopEnded = useCallback(() => {
      if (loopIsSegmentRef.current) {
        loopIsSegmentRef.current = false;
        window.dispatchEvent(new CustomEvent('video-ended'));
      } else if (idleLoopActiveRef.current) {
        // idle 模式：timeupdate 未及时 seek，这里兜底回开头
        const loopVideo = loopVideoRef.current;
        if (loopVideo) {
          loopVideo.currentTime = 0;
          loopVideo.play().catch(() => {});
        }
      }
    }, []);

    // 循环视频 timeupdate：① JS 接管 idle 无缝循环 ② 检查待切换 segment
    const onLoopTimeUpdate = useCallback(() => {
      const loopVideo = loopVideoRef.current;
      if (!loopVideo) return;

      // ① JS 接管 idle 无缝循环：距末尾不到 1 帧时立即 seek 回开头
      //    首尾帧像素一致（frame 0 = frame 125）→ 视觉零跳变
      if (idleLoopActiveRef.current && !loopVideo.paused) {
        const timeToEnd = loopVideo.duration - loopVideo.currentTime;
        if (timeToEnd < 0.05) {
          loopVideo.currentTime = 0;
          return; // 已经处理，不再检查 pending
        }
      }

      // ② 检查是否有待切换的 segment（仅 thinking 等待队列场景）
      if (pendingSrcRef.current && loopVideo.duration - loopVideo.currentTime < 0.1) {
        const originalSrc = pendingSrcRef.current;
        pendingSrcRef.current = null;
        resolveVideoSrc(originalSrc).then((resolved) => {
          showMain(resolved, originalSrc);
        });
      }
    }, [showMain, resolveVideoSrc]);

    // 初始加载待机动画（等 canplay 后才淡入，避免 Firefox 下无帧数据时显示黑底）
    useEffect(() => {
      const loopVideo = loopVideoRef.current;
      if (!loopVideo || !idleSrc) return;
      let cancelled = false;

      const setupIdle = (resolvedSrc: string) => {
        if (cancelled) return;
        const showIdle = () => {
          loopVideo.removeEventListener('canplay', showIdle);
          loopVideo.style.opacity = '1';
          loopVideo.style.pointerEvents = 'auto';
          loopVideo.play().catch(() => {
            console.warn('待机动画自动播放被阻止，等待用户交互');
          });
        };
        loopVideo.addEventListener('canplay', showIdle);
        assignVideoSrc(loopVideo, resolvedSrc, 'loop', idleSrc);
        loopVideo.loop = false; // JS 接管无缝循环
        idleLoopActiveRef.current = true;
        if (loopVideo.readyState >= 3) {
          showIdle();
        }
        window.setTimeout(() => {
          if (loopVideo.style.opacity !== '1') {
            showIdle();
          }
        }, 800);
      };

      resolveVideoSrc(idleSrc).then((resolved) => {
        setupIdle(resolved);
      }).catch(() => {
        setupIdle(idleSrc);
      });

      return () => {
        cancelled = true;
      };
    }, [idleSrc, resolveVideoSrc, assignVideoSrc]);

    return (
      <div
        style={{
          position: 'relative',
          // 移动端：上方区域占 32vh（留下空间给聊天面板）
          // 桌面端：75vh，靠 aspectRatio 9/16 自动算宽度
          height: isMobile ? '32vh' : '75vh',
          maxHeight: '100%',
          aspectRatio: '9 / 16',
          maxWidth: '100%',
          overflow: 'hidden',
          flexShrink: 0,
          background: '#FFFFFF',
          alignSelf: isMobile ? 'center' : 'auto',
        }}
      >
        {/* 主视频（播放 segment，有声音） */}
        <video
          ref={mainVideoRef}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            transform: 'scale(1.7)',
            transformOrigin: 'center center',
            zIndex: 1,
            opacity: 0,
            pointerEvents: 'none',
            transition: 'opacity 0.1s ease',
          }}
          playsInline
          preload="auto"
          onEnded={onMainEnded}
          onError={handleMainError}
        />

        {/* 循环视频（idle / thinking，静音） */}
        <video
          ref={loopVideoRef}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            zIndex: 1,
            opacity: 0,
            pointerEvents: 'none',
            transition: 'opacity 0.15s ease',
          }}
          playsInline
          preload="auto"
          muted
          onTimeUpdate={onLoopTimeUpdate}
          onEnded={onLoopEnded}
          onError={handleLoopError}
        />
      </div>
    );
  }
);

export default AvatarView;
