/**
 * 形象视频组件
 *
 * - 双 <video> absolute 叠加架构：主视频 + 循环视频（idle/analysis）
 * - opacity 过渡消除黑闪
 * - 首段切换：等待 analysis 循环自然结束
 */
import { useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react';

export interface AvatarViewHandle {
  /** 播放指定 URL 的视频 */
  play: (url: string) => void;
  /** 切换到循环视频（idle/analysis） */
  playLoop: (src: string) => void;
  /** 停止所有视频 */
  stop: () => void;
  /** 当前主视频是否正在播放 */
  isPlaying: () => boolean;
  /** 获取 video 元素引用 */
  getVideoElement: () => HTMLVideoElement | null;
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
      idleSrc = '/api/clips/idle/idle_breathing.webm?v=8',
      idleMp4Src = '/api/clips/idle/idle_breathing.mp4?v=8',
      analysisSrc = '/api/clips/idle/idle_breathing.webm?v=9',
      analysisMp4Src = '/api/clips/idle/idle_breathing.mp4?v=9',
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
    const activeElementRef = useRef<'main' | 'loop'>('loop'); // 当前可见的视频元素
    const loopIsSegmentRef = useRef(false); // loop 是否正在播放 segment（用于 ended 判断）
    const idleLoopActiveRef = useRef(false); // JS 手动接管 idle 无缝循环
    const loopMp4TriedRef = useRef(false); // loopVideo 是否已尝试 mp4 fallback（避免无限循环）
    const mainMp4TriedRef = useRef(false); // mainVideo 是否已尝试 mp4 fallback

    // 把 props 的 mp4 URL 同步到 ref，避免闭包问题
    const idleMp4Ref = useRef(idleMp4Src);
    const analysisMp4Ref = useRef(analysisMp4Src);
    idleMp4Ref.current = idleMp4Src;
    analysisMp4Ref.current = analysisMp4Src;

    /** 根据当前 loopVideo src 判断对应的 mp4 fallback URL */
    const pickLoopMp4Fallback = useCallback((): string | null => {
      const loopVideo = loopVideoRef.current;
      if (!loopVideo) return null;
      const src = loopVideo.src;
      if (!src) return null;
      // 当前是 mp4，无需 fallback
      if (src.includes('.mp4')) return null;
      // 根据路径特征判断是 idle 还是 analysis
      if (src.includes('analysis')) return analysisMp4Ref.current;
      return idleMp4Ref.current;
    }, []);

    /** loopVideo 错误兜底：webm 失败时尝试 mp4（仅一次） */
    const handleLoopError = useCallback(() => {
      if (loopMp4TriedRef.current) return;
      const loopVideo = loopVideoRef.current;
      if (!loopVideo) return;
      const fallback = pickLoopMp4Fallback();
      if (!fallback || fallback === loopVideo.src) return;
      console.warn('[AvatarView] loopVideo webm 加载失败，尝试 mp4 fallback:', fallback);
      loopMp4TriedRef.current = true;
      loopVideo.src = fallback;
      loopVideo.load();
    }, [pickLoopMp4Fallback]);

    /** mainVideo 错误兜底（用于 segments，未来扩展用） */
    const handleMainError = useCallback(() => {
      if (mainMp4TriedRef.current) return;
      const mainVideo = mainVideoRef.current;
      if (!mainVideo) return;
      // segments 当前没有 mp4，仅记录日志
      console.warn('[AvatarView] mainVideo 加载失败:', mainVideo.src);
      mainMp4TriedRef.current = true;
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
    const showMain = useCallback((url: string) => {
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

        // 先播放（首帧渲染后 Promise resolve）
        targetEl.play().then(() => {
          // 同一帧内：先隐藏旧帧，再显示新帧（避免任何重叠或空白帧）
          currentEl.style.transition = 'none';
          currentEl.style.opacity = '0';
          currentEl.style.pointerEvents = 'none';
          currentEl.pause();

          targetEl.style.transition = 'none';
          targetEl.style.opacity = '1';
          targetEl.style.pointerEvents = 'auto';
          targetEl.muted = false; // 切换完成后取消静音

          activeElementRef.current = currentActive === 'main' ? 'loop' : 'main';
        }).catch((err) => {
          // 自动播放被阻止：降级为同一帧切换
          console.warn('play() 被阻止，降级切换:', err.name);
          currentEl.style.transition = 'none';
          currentEl.style.opacity = '0';
          currentEl.style.pointerEvents = 'none';
          currentEl.pause();

          targetEl.style.transition = 'none';
          targetEl.style.opacity = '1';
          targetEl.style.pointerEvents = 'auto';
          targetEl.muted = false;

          activeElementRef.current = currentActive === 'main' ? 'loop' : 'main';
        });
      };

      // 预加载新段到目标元素
      targetEl.src = url;

      // canplay 后立即播放（静音），等待首帧渲染
      const onCanPlay = () => {
        targetEl.removeEventListener('canplay', onCanPlay);
        switchToTarget();
      };
      targetEl.addEventListener('canplay', onCanPlay);

      if (targetEl.readyState >= 3) {
        targetEl.removeEventListener('canplay', onCanPlay);
        switchToTarget();
      }

      mainSwitchTimerRef.current = window.setTimeout(() => {
        if (!mainReadyRef.current) {
          switchToTarget();
        }
      }, 800);
    }, [clearMainSwitchTimer, clearMainSrcClearTimer]);

    const showLoop = useCallback((src?: string) => {
      const mainVideo = mainVideoRef.current;
      const loopVideo = loopVideoRef.current;
      if (!mainVideo || !loopVideo) return;

      clearLoopSwitchTimer();
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
        // 只需隐藏 mainVideo，loopVideo 保持可见
        mainVideo.pause();
        mainVideo.style.transition = 'none';
        mainVideo.style.opacity = '0';
        mainVideo.style.pointerEvents = 'none';
      }

      clearMainSrcClearTimer();
      // mainVideo 作为桥接时不在此清除 src，等 loopVideo 就绪后再清除
      if (!mainIsBridge) {
        mainSrcClearTimerRef.current = window.setTimeout(() => {
          mainSrcClearTimerRef.current = null;
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
      const currentSrc = loopVideo.getAttribute('src');
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
          loopVideo.src = src;
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
              loopVideo.removeAttribute('src');
              loopVideo.load();

              // 后台加载 idle 到 loopVideo，就绪后切回正常循环
              const switchBackToLoop = () => {
                loopVideo.src = src;
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
            mainVideo.src = src;
            if (mainVideo.readyState >= 3) onMainReady();
            loopSwitchTimerRef.current = window.setTimeout(() => {
              if (mainVideo.style.opacity !== '1') onMainReady();
            }, 800);
          } else {
            // 标准路径：清除 loopVideo 旧数据，加载新 src，淡入
            loopVideo.style.transition = 'none';
            loopVideo.style.opacity = '0';
            loopVideo.style.pointerEvents = 'none';
            loopVideo.removeAttribute('src');
            loopVideo.load();

            // 强制 reflow，确保浏览器立即应用 opacity=0 后再设置新 src
            void loopVideo.offsetHeight;

            const onLoopReady = () => {
              loopVideo.removeEventListener('canplay', onLoopReady);
              clearLoopSwitchTimer();
              loopVideo.currentTime = 0;
              // 恢复过渡并淡入
              loopVideo.style.transition = 'opacity 0.15s ease';
              loopVideo.style.opacity = '1';
              loopVideo.style.pointerEvents = 'auto';
              // 隐藏桥接的 mainVideo 并释放资源（交叉淡化，避免空白帧）
              if (mainIsBridge) {
                clearMainSrcClearTimer();
                mainVideo.pause();
                mainVideo.style.transition = 'opacity 0.15s ease';
                mainVideo.style.opacity = '0';
                mainVideo.style.pointerEvents = 'none';
                // 延迟清除 src，等淡出完成
                window.setTimeout(() => {
                  mainVideo.src = '';
                  mainVideo.load();
                }, 200);
              }
              loopVideo.play().catch(() => {});
            };
            loopVideo.addEventListener('canplay', onLoopReady);
            loopVideo.src = src;
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
    }, [clearLoopSwitchTimer, clearMainSrcClearTimer]);

    // 暴露方法给父组件
    useImperativeHandle(ref, () => ({
      play(url: string) {
        const loopVideo = loopVideoRef.current;
        if (!loopVideo) return;

        // 切换主视频源时重置 mp4 fallback 状态
        resetMp4Fallback();

        // thinkingMode 或 src 包含 analysis 时排队等待（防止 segment_ready 竞态跳过思考动画）
        if (thinkingModeRef.current || loopVideo.src.includes('analysis')) {
          pendingSrcRef.current = url;
          // 兜底：5s 后如果仍未切换，强制播放 segment
          window.setTimeout(() => {
            if (pendingSrcRef.current === url) {
              pendingSrcRef.current = null;
              showMain(url);
            }
          }, 5000);
        } else {
          pendingSrcRef.current = null;
          showMain(url);
        }
      },

      playLoop(src: string) {
        // 切换循环视频源时重置 mp4 fallback 状态
        resetMp4Fallback();
        // 更新思考模式标志
        thinkingModeRef.current = src.includes('analysis');
        // 如果从 analysis 切走，取消待播放的 segment
        if (!src.includes('analysis')) {
          pendingSrcRef.current = null;
        }
        showLoop(src);
      },

      stop() {
        clearMainSrcClearTimer();
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

      isPlaying() {
        const mainVideo = mainVideoRef.current;
        return mainVideo ? !mainVideo.paused : false;
      },

      getVideoElement() {
        return mainVideoRef.current;
      },
    }), [showMain, showLoop, resetMp4Fallback]);

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
        const src = pendingSrcRef.current;
        pendingSrcRef.current = null;
        showMain(src);
      }
    }, [showMain]);

    // 初始加载待机动画（等 canplay 后才淡入，避免 Firefox 下无帧数据时显示黑底）
    useEffect(() => {
      const loopVideo = loopVideoRef.current;
      if (loopVideo && idleSrc) {
        const showIdle = () => {
          loopVideo.removeEventListener('canplay', showIdle);
          loopVideo.style.opacity = '1';
          loopVideo.style.pointerEvents = 'auto';
          loopVideo.play().catch(() => {
            console.warn('待机动画自动播放被阻止，等待用户交互');
          });
        };
        loopVideo.addEventListener('canplay', showIdle);
        loopVideo.src = idleSrc;
        loopVideo.loop = false; // JS 接管无缝循环
        idleLoopActiveRef.current = true;
        if (loopVideo.readyState >= 3) {
          showIdle();
        }
        // 兜底：800ms 后强制显示
        window.setTimeout(() => {
          if (loopVideo.style.opacity !== '1') {
            showIdle();
          }
        }, 800);
      }
    }, [idleSrc]);

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
