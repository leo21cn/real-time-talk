/**
 * 形象视频组件
 *
 * - 双 <video> absolute 叠加架构：主视频 + 循环视频（idle/analysis）
 * - opacity 过渡消除黑闪
 * - 首段切换：等待 analysis 循环自然结束
 * - 客户端预缓存：所有 *.src 赋值前先尝试 IndexedDB 命中 → URL.createObjectURL
 */
import { useRef, useCallback, useEffect, forwardRef, useImperativeHandle, memo } from 'react';
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
  /** V35: 在用户手势同步调用栈中预捕获播放权限，解锁 X5 自动播放策略 */
  captureGesture: () => void;
  /** V60: 中止正在进行的 play()/showMain() — error handler 触发时调用，防止已排队的 segment 覆盖 idle 状态 */
  abortPlay: () => void;
  /** V60: 清除 abort 标志 — 新一轮 handleSend 时调用，恢复正常播放 */
  clearAbort: () => void;
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
  /** V37: 微信移动端 — 不渲染视频，不播放动画与语音，只显示静态图 */
  isWeChatMobile?: boolean;
}

const AvatarView = memo(forwardRef<AvatarViewHandle, AvatarViewProps>(
  function AvatarView(
    {
      idleSrc = '/api/clips/idle/idle_breathing.webm?v=10',
      idleMp4Src = '/api/clips/idle/idle_breathing.mp4?v=10',
      analysisSrc = '/api/clips/idle/idle_breathing.webm?v=11',
      analysisMp4Src = '/api/clips/idle/idle_breathing.mp4?v=11',
      isMobile = false,
      isWeChatMobile = false,
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
    const videoEndedDispatchedRef = useRef(false); // V50: 防重入，同一 segment 只 dispatch 一次 video-ended
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

    // V35: 手势预捕获 — 记录最近一次用户交互时间戳
    const lastGestureTsRef = useRef<number>(0);
    // V35: play 失败计数 — 连续失败时显示轻触提示
    const playFailCountRef = useRef<number>(0);
    // V35: 轻触继续覆盖层 DOM 引用
    const tapOverlayRef = useRef<HTMLDivElement | null>(null);
    // V60 fix: showMain/play abort 标志 — error handler 触发后，
    //   之前 segment_ready 排队的 play() 在 await resolveVideoSrc 完成后
    //   会继续跑 showMain，强制把 main 设回 visible + 显示 segment 帧，
    //   覆盖 V58/V59 的 idle 状态。这里 error handler 调 abort()，
    //   showMain 和 play() 检查后立即返回，不再覆盖 idle 状态。
    const playAbortRef = useRef<boolean>(false);

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
        // V34: 先记录旧 blob URL，再设新 src，最后撤销旧 blob。
        // 之前先 revoke 再设 src 的时序在 X5 内核上会导致：
        // 视频元素在 revoke 后、新 src 赋值前的短暂窗口内持有已失效的 blob URL，
        // 浏览器进入错误状态 → canplay 永不触发 → 视频白屏/卡顿。
        const oldObjUrl = objRef.current;
        // 1. 先设新 src（确保视频元素始终有有效 src，不会进入错误状态）
        el.src = resolvedUrl;
        // 2. 再撤销旧 blob URL（安全，视频元素已指向新 src）
        if (oldObjUrl && oldObjUrl !== resolvedUrl) {
          try { URL.revokeObjectURL(oldObjUrl); } catch { /* ignore */ }
        }
        // 3. 更新跟踪引用
        const isObjectUrl = !!resolvedUrl && resolvedUrl.startsWith('blob:');
        objRef.current = isObjectUrl ? resolvedUrl : null;
        if (originalUrl !== undefined) {
          origRef.current = originalUrl;
        }
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
      // V34: assignVideoSrc 内部已正确处理旧 blob URL 撤销时序（先设新 src 再撤销旧 blob），
      // 不再需要前置 releaseVideoSrc（避免 revoke 后短暂窗口内视频元素持有失效 blob URL）。
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
        // V34: 先设新 src 再撤销旧 blob（与 assignVideoSrc 修复一致），
        // 避免视频元素在 revoke 后的短暂窗口内持有失效 blob URL → X5 错误状态。
        mainVideo.src = originalSrc;
        releaseVideoSrc('main');
        mainVideo.load();
      } else {
        console.warn('[AvatarView] mainVideo 加载失败:', currentSrc);
        mainMp4TriedRef.current = true;
      }
    }, [releaseVideoSrc]);

    /**
     * V35: 轻触继续覆盖层 — 当 play() 被 X5 自动播放策略阻止时，
     * 显示半透明播放按钮，用户轻触后在 touchstart 同步调用栈中调用 play() 解锁。
     */
    const showTapToPlayOverlay = useCallback(() => {
      // 移除已存在的覆盖层
      if (tapOverlayRef.current) {
        tapOverlayRef.current.remove();
        tapOverlayRef.current = null;
      }
      // 找到容器（video 元素的父 div）
      const mainVideo = mainVideoRef.current;
      if (!mainVideo || !mainVideo.parentElement) return;
      const container = mainVideo.parentElement;

      const overlay = document.createElement('div');
      overlay.style.cssText =
        'position:absolute;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(0,0,0,0.15);cursor:pointer;transition:opacity 0.3s ease;';

      // 播放按钮圆圈
      const btn = document.createElement('div');
      btn.style.cssText =
        'width:56px;height:56px;border-radius:50%;background:rgba(255,255,255,0.9);' +
        'display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.2);';

      // 三角播放图标
      const icon = document.createElement('div');
      icon.style.cssText =
        'width:0;height:0;border-left:22px solid #333;border-top:14px solid transparent;' +
        'border-bottom:14px solid transparent;margin-left:4px;';
      btn.appendChild(icon);
      overlay.appendChild(btn);

      // 提示文字
      const label = document.createElement('div');
      label.textContent = '轻触继续';
      label.style.cssText =
        'position:absolute;bottom:12px;left:0;right:0;text-align:center;' +
        'color:#666;font-size:13px;font-family:sans-serif;';
      overlay.appendChild(label);

      // 轻触/点击处理 — 在同步调用栈中调用 play() 解锁 X5 自动播放
      const handleTap = () => {
        overlay.removeEventListener('click', handleTap);
        overlay.removeEventListener('touchstart', handleTap);
        // 找到当前可见的视频元素并播放
        const activeEl = activeElementRef.current;
        const videoEl = activeEl === 'main' ? mainVideoRef.current : loopVideoRef.current;
        if (videoEl) {
          videoEl.muted = true;
          videoEl.play().then(() => {
            videoEl.muted = false;
          }).catch(() => {
            // 仍然失败，静默移除覆盖层
          });
        }
        playFailCountRef.current = 0;
        overlay.style.opacity = '0';
        setTimeout(() => {
          overlay.remove();
          if (tapOverlayRef.current === overlay) {
            tapOverlayRef.current = null;
          }
        }, 300);
      };
      overlay.addEventListener('click', handleTap);
      overlay.addEventListener('touchstart', handleTap, { passive: true });

      container.appendChild(overlay);
      tapOverlayRef.current = overlay;
    }, []);

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
      // V60 fix: 如果 abort 标志被设置（error handler 触发），跳过 showMain
      if (playAbortRef.current) {
        console.warn('[V60] showMain aborted, error handler triggered');
        return;
      }
      const mainVideo = mainVideoRef.current;
      const loopVideo = loopVideoRef.current;
      if (!mainVideo || !loopVideo) return;

      clearMainSwitchTimer();
      clearMainSrcClearTimer();
      thinkingModeRef.current = false;
      idleLoopActiveRef.current = false;
      mainReadyRef.current = false;
      // V50: 新 segment 开始，重置 video-ended 防重入标志
      videoEndedDispatchedRef.current = false;

      // 确定谁是当前可见的（旧帧）和谁将预加载新段
      const currentActive = activeElementRef.current;
      const targetEl = currentActive === 'main' ? loopVideo : mainVideo;
      const currentEl = currentActive === 'main' ? mainVideo : loopVideo;

      // 配置目标元素用于 segment 播放
      if (targetEl === loopVideo) {
        loopIsSegmentRef.current = true;
        // V48.4: 与 mainVideo 一致 scale(1) — 让 segment 视频在 loopVideo 上播放时
        // 也保持视觉大小统一（避免 segment_1/3/5 在 loopVideo 上看起来"被裁剪变小"）。
        loopVideo.style.transform = 'scale(1)';
        loopVideo.style.transformOrigin = 'center center';
        loopVideo.muted = true; // 先静音，等切换完成再取消静音
        loopVideo.volume = 1.0;
        loopVideo.loop = false;
      } else {
        loopIsSegmentRef.current = false;
        mainVideo.muted = true; // 先静音，等切换完成再取消静音
        mainVideo.volume = 1.0;
      }

      // V53 fix: 确保 currentEl 作为桥接帧可见。showLoop 的 bridge 逻辑可能
      // 已将 currentEl 设为 opacity=0（loopVideo hidden, mainVideo 显旧帧），
      // 此时 targetEl 加载新 src 会空白 → 双黑屏 → 卡死。
      // 显式恢复 currentEl 作为加载期间的视觉桥接。
      currentEl.style.transition = 'none';
      currentEl.style.opacity = '1';
      currentEl.style.pointerEvents = 'auto';

      const switchToTarget = () => {
        if (mainReadyRef.current) return;
        mainReadyRef.current = true;
        clearMainSwitchTimer();

        // V33: 独立追踪 finalize 是否已被调用。
        // 原设计完全依赖 play().then() 来触发 finalize，但在 X5 内核上
        // play() 可能永远不 resolve 也不 reject（静默 pending），导致
        // finalize 永不调用 → targetEl 不可见 → 卡通形象卡住不动。
        // 用独立标志 + 超时兜底确保 finalize 最终一定被调用。
        let finalizeCalled = false;
      
        // V15 修复（移动端 4G/5G 段落间闪烁）：保留 currentEl 最后一帧作为桥接，
        // 等 targetEl 真正开始播放（playing 事件触发）后再涪出 currentEl，
        // 避免在 targetEl 还未解码出首帧时同时隐藏旧帧 + 显示空白帧。
        // 允底超时 300ms：autoplay 被阻止/解码极慢时强制涪出 currentEl。
        const finalize = () => {
          if (finalizeCalled) return;
          finalizeCalled = true;
          // targetEl 立即可见（如果它已可显示首帧，用户立即看到）
          targetEl.style.transition = 'none';
          targetEl.style.opacity = '1';
          targetEl.style.pointerEvents = 'auto';
          // V53 fix: finalize 后强制重播一次，避免上游 play() 被某种因素
          // (Chrome autoplay policy / 时序竞态) 隐式暂停导致首帧冻结。
          // mute=false 后 play() 需要用户手势上下文（handleSend 中 captureGesture 提供）。
          if (targetEl.paused) {
            targetEl.play().catch(() => { /* ignore */ });
          }
          // V11: play() 成功后延迟 unmute（确保 currentTime > 0 才允许声音）
          // 避免某些浏览器因 unmute 提前而阻止后续 play
          if (targetEl.currentTime > 0.05 || targetEl.readyState >= 2) {
            targetEl.muted = false;
          } else {
            const tryUnmute = () => {
              if (targetEl.currentTime > 0.05) {
                targetEl.muted = false;
                targetEl.removeEventListener('timeupdate', tryUnmute);
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
          // V48 fix: 恢复 f549284 的快速涪出分支。
          // 在 PC Chrome 标准浏览器上，targetEl.play().then() 解析时首帧通常已可显示
          // （webm/mp4 已预热 / IndexedDB 缓存命中），此时直接涪出 currentEl 比等
          // RVFC 帧回调快得多（避免 currentEl 旧帧停留造成“卡顿”）。
          // RVFC + playing event 兜底保留用于 5G/X5 慢网解码延迟场景。
          if (!targetEl.paused && targetEl.currentTime > 0) {
            // 快速路径：targetEl 已在播 → 立即涪出 currentEl
            fadeOutCurrent();
            return;
          }
          // 慢网兑底：V30 RVFC 首帧等待路径（覆盖 5G 慢解码）。最多等 1500ms。
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
          // V33: 如果 targetEl 已经在播放（playing 事件已过），通过 readyState 判断
          if (targetEl.readyState >= 3 && !targetEl.paused && targetEl.currentTime > 0) {
            setTimeout(onFirstFrame, 60);
          }
          // 兑底2：硬超时 1500ms（原 300ms 不足以覆盖 5G 慢解码）
          const hardFallback = window.setTimeout(() => {
            targetEl.removeEventListener('playing', onPlaying);
            onFirstFrame();
          }, 1500);
        };
      
        // V13 修复：play() 可能被自动播放策略阻止（尤其当用户点击发送后一段时间才到下一段），
        // 这里采用"重试降级"策略：play() 失败后先 unmute 再重试（muted autoplay 通常不被拒，
        // 但有时会与之前的 unmute 状态冲突）；最终失败时保持 muted + 静态帧（V11 逻辑）。
        // V33 修复：增加 Promise.race 超时（2000ms），解决 X5 内核 play() 静默 pending 问题。
        const PLAY_TIMEOUT_MS = 2000;
        const attemptPlay = (attempt: number): void => {
          // 第一次 muted 试播（Chrome / Safari 均允许 muted autoplay）
          if (attempt === 1) {
            targetEl.muted = true;
          }
      
          // V33: 用 Promise.race 包装 play()，防止 X5 内核上永远 pending
          const playPromise = targetEl.play();
          const timeoutPromise = new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('play() timeout')), PLAY_TIMEOUT_MS)
          );
      
          Promise.race([playPromise, timeoutPromise]).then(() => {
            finalize();
          }).catch((err) => {
            const errMsg = (err as any)?.message || (err as any)?.name || 'unknown';
            if (attempt <= 2) {
              // 重试策略：attempt 1 等 80ms，attempt 2 等 200ms
              const retryDelay = attempt === 1 ? 80 : 200;
              console.warn(`play() 被阻止/超时 (attempt ${attempt})，${retryDelay}ms后重试:`, errMsg);
              if (attempt === 1) {
                try { targetEl.load(); } catch { /* ignore */ }
              }
              window.setTimeout(() => attemptPlay(attempt + 1), retryDelay);
            } else {
              // V33: 最终兜底 — 无论如何都调 finalize，确保 targetEl 可见
              console.warn('play() 最终失败/超时，降级切换（保持 muted）:', errMsg);
              finalize();
              // V35: play 被 X5 自动播放策略阻止 → 显示轻触继续覆盖层
              // 用户轻触后在 touchstart 同步调用栈中调用 play() 解锁
              playFailCountRef.current++;
              if (targetEl.paused) {
                window.setTimeout(() => showTapToPlayOverlay(), 100);
              }
            }
          });
        };
        attemptPlay(1);
      
        // V33: 额外硬兜底 — 6000ms 后如果 finalize 还没被调，强制调用。
        // 覆盖极端情况：attemptPlay 3 次重试（≈2280ms）+ 余量。
        // 原 5000ms 在 showMain 层检查 mainReadyRef（已被设 true → 失效），
        // 这里新增独立兜底不依赖任何状态标志。
        mainSwitchTimerRef.current = window.setTimeout(() => {
          if (!finalizeCalled) {
            console.warn('[AvatarView] 6000ms 硬兜底：finalize 未触发，强制切视频');
            // 最后一次尝试 muted play（不依赖 Promise）
            try { targetEl.muted = true; targetEl.play().catch(() => {}); } catch { /* ignore */ }
            finalize();
          }
        }, 6000);
      };

      // 预加载新段到目标元素（先尝试 IndexedDB 命中 → objectURL，避免回源）
      // V34: assignVideoSrc 已修复 blob URL 时序（先设新 src 再撤销旧 blob），
      // 标准浏览器设置 el.src 后自动触发隐式 load()，无需手动调用。
      // V35 手势预捕获刷新已移除：在 PC 标准浏览器上，play() 会先播放旧内容再被
      // assignVideoSrc 中断，导致新 src 的 canplay 时序被打乱引起卡顿。
      // X5 自动播放解锁完全依赖 captureGesture（handleSend 中同步调用），不再此处刷新。
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
      clearMainSwitchTimer(); // V34: 清理 showMain 残留的硬兜底定时器，防止在新一轮 showLoop 期间误触发
      // V25: 清理上一次的桥接涪出兑底定时器
      if (bridgeFadeTimerRef.current) {
        window.clearTimeout(bridgeFadeTimerRef.current);
        bridgeFadeTimerRef.current = null;
      }
      loopIsSegmentRef.current = false;

      // 判断是否为 idle 模式
      const isIdle = !src || !src.includes('analysis');

      // V51: speaking→idle 时 loopVideo 带有 scale(0.589)，保持桥接避免空白闪烁
      const loopHasScale = loopVideo.style.transform.includes('scale(0.589)');
      let mainIsBridge = false;
      if (loopHasScale) {
        if (isIdle) {
          // V58 fix: segment→idle 切换时**不再**用 main 当桥接。
          // 背景：原代码把 main 设成桥接（用 segment 帧挡白），依赖 canplay + 2s
          //   兜底淡出 main 露出 loop。在某些环境（X5 内核、audio 残留、TTS
          //   错误快速回退等）下 canplay 不触发，桥接淡出永远不完成 → avatar 卡
          //   在 segment 帧上，loop 永远 hidden，send 按钮可用但视觉卡死。
          //   用户报"说一句话后没有切到等待动画"+"长段话说一半卡住"都是这
          //   个原因。
          // 修复：直接 hide main，保留 loop 当前帧（analysis 帧）作占位。
          //   standard path Y(loopVideo, idle) → canplay → ye 把 loop 切到 idle。
          //   视觉：analysis 帧 → (IDB 缓存命中，load 几乎瞬时) → idle 帧。
          //   允许 1-2 帧占位闪，但绝不会再卡死。
          mainVideo.pause();
          mainVideo.style.transition = 'none';
          mainVideo.style.opacity = '0';
          mainVideo.style.pointerEvents = 'none';
          mainIsBridge = false;
        } else if (activeElementRef.current === 'main') {
          loopVideo.pause();
          loopVideo.style.transition = 'none';
          loopVideo.style.opacity = '0';
          loopVideo.style.pointerEvents = 'none';
          mainIsBridge = true;
        } else {
          const mainHasContent = mainVideo.src && mainVideo.readyState >= 1;
          if (mainHasContent) {
            // 有 mainVideo 桥接内容 → 隐藏 loopVideo，用 mainVideo 过渡
            loopVideo.style.transition = 'none';
            loopVideo.style.opacity = '0';
            loopVideo.style.pointerEvents = 'none';
            loopVideo.pause();
            mainVideo.style.transition = 'none';
            mainVideo.style.opacity = '1';
            mainVideo.style.pointerEvents = 'auto';
            mainIsBridge = true;
          }
          // V52 fix: mainVideo 无内容时，不操作 loopVideo（无需 hide→show 闪烁）。
          // loopVideo 正在显示 idle 动画，保持当前状态即可。
          // 首次交互时此路径会导致 blink：opacity=0→pause→opacity=1，视觉卡顿。
        }
      } else {
        const mainHasContent = mainVideo.src && mainVideo.readyState >= 1;
        if (activeElementRef.current === 'main' && mainHasContent) {
          mainVideo.pause();
          mainVideo.style.transition = 'none';
          mainVideo.style.opacity = '1';
          mainVideo.style.pointerEvents = 'auto';
          mainIsBridge = true;
        } else {
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
          // V48 fix: 不要清空 mainVideo.src！
          // 原因：mainVideo.src = '' 会触发 MEDIA_ERR_SRC_NOT_SUPPORTED (error 4) 错误状态，
          // 即使下次 showMain 设了新 src，video element 也可能不会立即重置。
          // 保留 src （是上一个 segment 的 URL），下次 showMain 调用 assignVideoSrc
          // 会用新 src 替换（assignVideoSrc 内部先设新 src 再 revoke 旧 blob）。
          // 不调用 load() 避免清空浏览器已缓存的视频帧。
        }, 150);
      }
      if (isIdle) {
        // V64.1 fix: 重置 loopVideo transform 从 scale(1) 回到 scale(0.589)
        // 原因: V48.4 fix 在 showMain(targetEl=loopVideo) 播 segment 时设了 scale(1),
        //       切回 idle 时如果不重置, loop 视频卡在全尺寸 1.0 上, 卡通形象看起来"变大".
        loopVideo.style.transform = 'scale(0.589)';
        loopVideo.style.transformOrigin = 'center center';
        // idle：JS 接管无缝循环
        loopVideo.loop = false;
        idleLoopActiveRef.current = true;
      } else {
        // V48 fix: analysis 也改用 JS 无缝循环（原生 loop=true 在 restart 时
        // 触发 ended→空白帧→用户看到卡通形象消失）
        loopVideo.loop = false;
        idleLoopActiveRef.current = false;
      }

      // 比较完整 URL（包含 query 参数），避免相同 base path 但不同 ?v 的 URL
      // 被误判为相同（例：idle?v=10 vs idle?v=11）。V48 修复前的分析动画
      // 实际指向 idle 路径，showLoop 跳过了 src 切换，导致卡通形象在 thinking
      // 状态下沿用 idle 动画 → "语音死循环" 视觉错觉。
      const currentSrc = loopOriginalUrlRef.current || loopVideo.getAttribute('src');
      const currentFull = currentSrc ? currentSrc.split('#')[0] : '';
      const newFull = src ? src.split('#')[0] : '';
      if (src && currentFull !== newFull) {
        if (!isIdle) {
          // idle→analysis：V48 fix 立即设置 opacity=1 保留当前帧作为桥接，避免被
          // showMain 抢断。背景：LLM 响应过快时（hi/简单问候 < 1s），segment_ready
          // 赶在 loopVideo canplay 之前到达，showMain finalize fadeOut currentEl 会
          // 强制隐藏 loopVideo（opacity=0），用户跳过 thinking 动画直接看到 mainVideo
          // 播 segment。现在先保留当前帧 (idle)，等 canplay 后再切换到 analysis。
          loopVideo.style.transition = 'none';
          loopVideo.style.opacity = '1';
          loopVideo.style.pointerEvents = 'auto';
          const onLoopReady = () => {
            loopVideo.removeEventListener('canplay', onLoopReady);
            clearLoopSwitchTimer();
            loopVideo.currentTime = 0;
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
          // 其他切换
          if (loopHasScale && !mainIsBridge) {
            // V51: 死代码安全网（loopHasScale 通常有 mainIsBridge=true，此分支不可达）
            if (!mainVideo || !loopVideo) return;
          } else {
            // V11 修复：标准路径
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
                    // V48 fix: 不要清空 mainVideo.src！保留给下次 segment 复用
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
        // V53 fix: 隐藏桥接的 mainVideo 时**不再暂停**它。
        // 原因：若此时 play() 路径正在异步加载新 segment 并 attemptPlay，
        // 暂停 mainVideo 会中断其 play() Promise，导致视频停在首帧。
        // 仅隐藏（opacity=0）即可达到视觉隐藏效果，保留播放状态供后续无缝衔接。
        if (mainIsBridge) {
          clearMainSrcClearTimer();
          mainVideo.style.transition = 'none';
          mainVideo.style.opacity = '0';
          mainVideo.style.pointerEvents = 'none';
        }
        loopVideo.play().catch(() => {});
      } else {
        // src 相同，直接显示（保持 idle 循环或 analysis）
        // V48 fix: loopVideo.loop 永远 false，依赖 onLoopTimeUpdate JS 接管循环。
        const isSameIdle = !src.includes('analysis');
        loopVideo.loop = false;
        idleLoopActiveRef.current = isSameIdle;
        loopVideo.style.opacity = '1';
        loopVideo.style.pointerEvents = 'auto';
        // V52 修复: 不要设置 currentTime=0。首次交互时 captureGesture 刚启动 loopVideo，
        // seek 到 0 会导致解码重置 → 视觉卡顿；后续交互 video 已在播，seek 到 0 也会跳帧。
        // src 没变，保持当前播放位置即可。
        // V56 fix: 不再立即淡出 mainVideo。
        // 背景：此分支被重复 playLoop 同 URL 调用触发（如 App.tsx state_change idle 与
        //       tryGoIdle 之间的二次回调）。src 没变说明 loopVideo 已经在播，重复调
        //       是冗余；立即 opacity=0 桥接淡出会导致短暂"两层都不可见"窗口 → avatar 闪烁/消失。
        //       修复：保留 mainVideo 可见，作为视觉后备（idle loop 播放时用户视觉上看不到
        //       桥接视频，因为 loopVideo 在上层）。当下一次真实段视频到来时（src 改变走 if 分支）
        //       才需要正确的桥接淡出。
        loopVideo.play().catch(() => {});
      }

      activeElementRef.current = 'loop';
    }, [clearLoopSwitchTimer, clearMainSrcClearTimer, assignVideoSrc, releaseVideoSrc]);

    // 暴露方法给父组件
    // V37: 微信移动端 → 所有方法都是 no-op，不依赖任何视频元素
    useImperativeHandle(ref, () => {
      if (isWeChatMobile) {
        return {
          play: () => { /* no-op: 微信端不播放动画 */ },
          playLoop: () => { /* no-op: 微信端不播放动画 */ },
          stop: () => { /* no-op */ },
          reset: () => { /* no-op */ },
          isPlaying: () => false,
          getVideoElement: () => null,
          preloadVideo: () => { /* no-op */ },
          consumePreloadedBlob: () => null,
          preloadVideoAsync: async () => null,
          warmupVideoElement: async () => { /* no-op */ },
          clearPreloadedBlobs: () => { /* no-op */ },
          captureGesture: () => { /* no-op: 微信端不需要解锁自动播放 */ },
          abortPlay: () => { /* no-op: 微信端不播视频 */ },
          clearAbort: () => { /* no-op */ },
        };
      }
      return ({
      async play(url: string) {
        const loopVideo = loopVideoRef.current;
        if (!loopVideo) return;

        // V60 fix: 注意 — 不在这里 reset playAbortRef！
        // 原因：本轮 response 期间，video-ended 事件会触发 videoPlaylistRef 队列里
        // 后续 segment 的 play()（如 segment_1）。如果在 play() 里 reset abort 标志，
        // 后续 segment 的 showMain 会绕过 abort，覆盖 idle 状态。
        // abort 标志只在用户发送新一轮消息（handleSend）时由 clearAbort() 显式清掉。

        // 切换主视频源时重置 mp4 fallback 状态
        resetMp4Fallback();

        // V4: 优先使用预下载的 blob（如果之前已 preloadVideo 过）
        const preloaded = preloadedBlobsRef.current.get(url);
        if (preloaded) {
          preloadedBlobsRef.current.delete(url);
          pendingSrcRef.current = null;
          showMain(preloaded, url);
          return;
        }

        // V53: 无缓存时等待 in-flight 预加载（handleSegmentReady 已发起 preloadVideo），
        // 而不是从头 resolveVideoSrc（会导致重复下载 + 段间延迟）。
        // 注意：首段播放时 preloadVideo 未调用，preloadPendingRef 为空，
        // preloadVideoAsync 会启动新下载 → 可能因服务端未就绪而反复 404 重试 → 卡死。
        // 首段直接走 resolveVideoSrc 路径（网络直连，更快）。
        pendingSrcRef.current = null;
        const isFirstSegment = !preloadPendingRef.current || preloadPendingRef.current.size === 0;
        if (isFirstSegment) {
          const resolved = await resolveVideoSrc(url);
          showMain(resolved, url);
        } else {
          const blob = await Promise.race([
            this.preloadVideoAsync(url),
            new Promise<string | null>(r => setTimeout(() => r(null), 5000)),
          ]);
          if (blob) {
            preloadedBlobsRef.current.delete(url);
            showMain(blob, url);
          } else {
            console.warn(`[V53] preload 超时，降级为网络直连: ${url}`);
            const resolved = await resolveVideoSrc(url);
            showMain(resolved, url);
          }
        }
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
        try {
          const resolved = await resolveVideoSrc(src);
          showLoop(resolved, src);
        } catch (err) {
          // V48 fix: resolveVideoSrc 可能因网络/IDB 错误失败，降级使用原始 URL
          console.warn('[AvatarView] playLoop resolveVideoSrc 失败，降级使用原始 URL:', err);
          showLoop(src, src);
        }
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
          // V48 fix: reset() 是显式状态重置（新会话），可安全清空 src
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
        // 清 warmup 状态：防止对老 blobUrl 走"已解码完成"快速路径
        warmupMapRef.current.clear();
        warmupPromiseMapRef.current.clear();
        // 清 pending retry 集合
        if (preloadPendingRef.current) {
          preloadPendingRef.current.clear();
        }
      },
    
      // V35: 手势预捕获 — 在用户手势（click/touchstart）同步调用栈中调用，
      // 对两个 video 元素执行 muted play()→pause() 以解锁 X5 自动播放策略。
      // 浏览器将手势 token 关联到页面/元素，后续 WebSocket 回调中的 play() 更可能成功。
      captureGesture() {
        lastGestureTsRef.current = Date.now();
        [mainVideoRef.current, loopVideoRef.current].forEach((el) => {
          if (!el) return;
          el.muted = true;
          const p = el.play();
          if (p && typeof p.then === 'function') {
            p.then(() => {
              // V52: 不再 pause loopVideo，避免 idle 动画停顿造成"卡住"感知。
              // 只需在用户手势栈中触发一次 play() 即可解锁自动播放策略。
              if (el !== loopVideoRef.current) {
                el.pause();
              }
            }).catch(() => { /* 预捕获失败不影响后续流程 */ });
          }
        });
      },

      // V60: 中止正在进行的 play()/showMain() — error handler 在 setState(Idle) 之后
      // 调 abortPlay()，让之前 segment_ready 排队的 play() 在 await resolveVideoSrc
      // 完成后立即返回，不再 showMain 覆盖 idle 状态。
      abortPlay() {
        playAbortRef.current = true;
        // 清空 preloaded blobs + pending 队列，防止 abort 后还有 stale 数据
        preloadedBlobsRef.current.clear();
        preloadPendingRef.current?.clear();
      },

      // V60: 清除 abort 标志 — 新一轮 handleSend 时调用，恢复正常播放。
      // 必须在 abortPlay 调用的同一轮 response 期间，video-ended 触发的后续 segment
      // 播放（来自 videoPlaylistRef 队列）也能被 abort 拦截 — play() 内部不再 reset
      // 此标志（避免和 abort 逻辑打架），仅在 handleSend 显式 clear。
      clearAbort() {
        playAbortRef.current = false;
      },
    })}, [isWeChatMobile, showMain, showLoop, resetMp4Fallback, resolveVideoSrc, releaseVideoSrc, assignVideoSrc]);

    // 主视频播放完毕回调
    const onMainEnded = useCallback(() => {
      // V50: 防重入 — 同一 segment 只 dispatch 一次
      if (videoEndedDispatchedRef.current) return;
      videoEndedDispatchedRef.current = true;
      window.dispatchEvent(new CustomEvent('video-ended'));
    }, []);

    // 循环视频 ended 回调：segment 结束通知父组件；idle/analysis 兜底 seek(0) 重播
    const onLoopEnded = useCallback(() => {
      if (loopIsSegmentRef.current) {
        loopIsSegmentRef.current = false;
        // V50: 防重入 — 同一 segment 只 dispatch 一次
        if (videoEndedDispatchedRef.current) return;
        videoEndedDispatchedRef.current = true;
        window.dispatchEvent(new CustomEvent('video-ended'));
      } else {
        // V48 fix: idle 和 analysis 都兜底 seek(0) 重播（JS 无缝循环未拦截时的安全网）
        const loopVideo = loopVideoRef.current;
        if (loopVideo) {
          loopVideo.currentTime = 0;
          loopVideo.play().catch(() => {});
        }
      }
    }, []);

    // 循环视频 timeupdate：① JS 接管无缝循环（idle + analysis）② 检查待切换 segment
    const onLoopTimeUpdate = useCallback(() => {
      const loopVideo = loopVideoRef.current;
      if (!loopVideo) return;

      // ① V48 fix: JS 无缝循环 — 仅适用于 idle/analysis，**不适用于 segment**。
      //    segment 视频需要让浏览器原生 ended 触发 video-ended 事件，切下一段或切回 idle。
      //    如果这里在 segment 快到结尾时 seek 到 0，会让视频视觉上突然跳回开头，
      //    而 audio 持续播放 → 口型从头循环 ≈ target/4.833 次 → 用户感知「重复读」。
      if (!loopIsSegmentRef.current && !loopVideo.paused) {
        const timeToEnd = loopVideo.duration - loopVideo.currentTime;
        if (timeToEnd < 0.05) {
          loopVideo.currentTime = 0;
          return;
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
          // V65: 微信移动端 avatar 占屏幕 2/5 (40vh), 留出顶部空间让脑袋完整露出来
          //   之前 160px 太小, 头像几乎贴顶部边缘. 现在 40vh ≈ 640px (1600px viewport),
          //   aspectRatio 3/4 算出 width ≈ 480px, head/body/hand 完整可见.
          //   marginTop 24px 额外留出顶部安全空间, 避免 head 贴边.
          height: isWeChatMobile ? '40vh' : (isMobile ? '267px' : '75vh'),
          aspectRatio: '3 / 4',
          maxWidth: '540px',
          maxHeight: isWeChatMobile ? '50vh' : '75vh',
          minWidth: '300px',
          flexShrink: 0,
          flexGrow: 0,
          flexBasis: 'auto',
          overflow: 'hidden',
          background: '#FFFFFF',
          alignSelf: isMobile ? 'center' : 'auto',
          marginTop: isWeChatMobile ? '48px' : '0',
          // V66: 加上 paddingTop 给头顶留 breathing room (objectFit:contain 模式下
          //   静态 PNG 头像在图片顶部, 容器无 padding 会让头贴边)
          paddingTop: isWeChatMobile ? '32px' : '0',
        }}
      >
        {/* V37: 微信移动端 — 静态普兰图，不播放任何动画/语音 */}
        {isWeChatMobile ? (
          <img
            src="/pulan_static.png"
            alt="普兰"
            draggable={false}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              // V66: 去掉 scale(1.1), 改用 objectPosition 把头顶放在稍低位置
              //   - scale(1.1) 让图片溢出 container 5%, 把头顶/手顶裁掉
              //   - objectPosition 控制 objectFit:contain 模式下图片在容器内的位置
              //   - 'center 15%' 让图片在垂直方向向上偏移 15% (顶部 15% 留空),
              //     这样头顶有 ~10% 容器高度的 breathing room, 不会贴边
              objectPosition: 'center 15%',
              transform: 'none',
              userSelect: 'none',
              WebkitUserSelect: 'none',
            }}
          />
        ) : (
          <>
            {/* V67: 视频兜底静态图. video 元素失败/error/无 src 时自动显示.
                永远在视频下面 (zIndex 0), 视频 opacity 0 或 error 时露出来, 视频正常播放时被盖住.
                避免长回答后 loop video 加载失败导致"卡通形象消失"的空白. */}
            <img
              src="/pulan_static.png"
              alt="普兰 (静态)"
              draggable={false}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                // 与 loop video 一致: 缩小到 58.9% 让普兰可见高度匹配 speaking 段
                transform: 'scale(0.589)',
                transformOrigin: 'center center',
                zIndex: 0,
                userSelect: 'none',
                WebkitUserSelect: 'none',
                pointerEvents: 'none',
              }}
            />
            {/* 主视频（播放 segment，有声音） */}
            <video
              ref={mainVideoRef}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                // V48.4 fix: scale(1) 恢复不裁剪，video 完整 fit 容器。
                // 背景：scale(1.5) 会让 idle 状态普兰腿部被裁剪（普兰 height 474px in element 522px
                //   + scale 1.5 transformOrigin center → 普兰 visible content 反而 缩小 到 348px，
                //   比 scale 1.0 (474px) 还小）。原因：transformOrigin center center 让元素从中心放大，
                //   但容器裁剪后只显示中间一段，裁剪比例 = 容器/元素_rendered = 522/(474*1.5) = 73%，
                //   普兰 visible content = 474 * 73% = 348，反而比不放大小。
                // scale 1.0 保证 video 完整 fit 容器不被裁剪，
                //   - idle 完整普兰 visible ~70% 容器（最佳观看）
                //   - segment 特写帧 visible ~40% 容器（接受较小，因 clip 资源限制）
                //   - segment 完整帧 visible ~70% 容器（与 idle 一致）
                transform: 'scale(1)',
                transformOrigin: 'center center',
                zIndex: 1,
                opacity: 0,
                pointerEvents: 'none',
                transition: 'opacity 0.1s ease',
              }}
              playsInline
              preload="auto"
              // @ts-ignore X5 内核同层播放属性（仅腾讯系浏览器生效）
              x5-playsinline=""
              x5-video-player-type="h5"
              x5-video-player-fullscreen="false"
              webkit-playsinline=""
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
                // V51: idle 视频普兰占帧 99.5%，speaking 占 58.6%。
                // scale(0.589) 缩小 idle 使普兰可见高度匹配 speaking（75vh × 58.6% = 44vh）。
                transform: 'scale(0.589)',
                transformOrigin: 'center center',
                zIndex: 1,
                opacity: 0,
                pointerEvents: 'none',
                transition: 'opacity 0.15s ease',
              }}
              playsInline
              preload="auto"
              muted
              // @ts-ignore X5 内核同层播放属性（仅腾讯系浏览器生效）
              x5-playsinline=""
              x5-video-player-type="h5"
              x5-video-player-fullscreen="false"
              webkit-playsinline=""
              onTimeUpdate={onLoopTimeUpdate}
              onEnded={onLoopEnded}
              onError={handleLoopError}
            />
          </>
        )}
      </div>
    );
  }
));

export default AvatarView;
