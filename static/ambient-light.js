/* 環境光(Ambient light):依影片畫面的顏色在影片周圍柔和發光。
 *
 * 作法參考 YouTube Ambilight / Ambient light for YouTube(MIT License,
 * Copyright (c) 2017 Wessel Kroos,https://github.com/WesselKroos/youtube-ambilight)
 * 的渲染管線,依行車記錄器播放器的需求精簡重寫(未複製其程式碼):
 *   1. 只在影片產生「新影格」時取樣(requestVideoFrameCallback;不支援時退回限速的 rAF),
 *      並限制每秒取樣次數以省電;暫停時只畫一次。
 *   2. 取樣畫到極小的畫布(48×27),由 GPU 放大 + CSS blur / saturate 形成光暈,
 *      不在 JS 端做逐像素運算,也不讀回像素(getImageData)。
 *   3. 影格混合(frame blending):新影格以部分透明度疊在上一張上,光線變化平滑、不閃爍;
 *      跳轉(seek)時則整張重畫,立即跟上新畫面。
 *   4. 以遮罩(mask)讓光暈往外漸淡,類似原專案的 spread / fade 曲線。 */
(() => {
  const SAMPLE_FPS = 24;          // 取樣上限(光暈不需要全速)
  const BLEND_ALPHA = 0.28;       // 影格混合:每次新畫面佔的比重

  function create({ canvas, stage, source, spread = 0.09 }) {
    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "low";
    let enabled = true;
    let video = null;
    let vfcId = 0;
    let rafId = 0;
    let lastDraw = 0;
    let fresh = true;               // 下一張整張重畫(跳轉、換鏡頭、剛開啟)

    function place() {
      // 光暈比影片四周各大一圈(spread);尺寸只在版面改變時更新
      const parent = canvas.parentElement;
      if (!parent) return;
      const pr = parent.getBoundingClientRect();
      const sr = stage.getBoundingClientRect();
      const padX = sr.width * spread;
      const padY = sr.height * spread * 1.4;
      Object.assign(canvas.style, {
        left: `${sr.left - pr.left - padX}px`,
        top: `${sr.top - pr.top - padY}px`,
        width: `${sr.width + padX * 2}px`,
        height: `${sr.height + padY * 2}px`,
      });
    }

    function draw(now = performance.now()) {
      if (!enabled || !video || video.readyState < 2) return;
      if (!fresh && now - lastDraw < 1000 / SAMPLE_FPS) return;
      lastDraw = now;
      try {
        ctx.globalAlpha = fresh ? 1 : BLEND_ALPHA;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        fresh = false;
        canvas.classList.add("is-live");
      } catch {
        /* 影片尚未可解碼時略過 */
      }
    }

    function loop() {
      stop();
      if (!enabled || !video) return;
      if (typeof video.requestVideoFrameCallback === "function") {
        const onFrame = (now) => {
          draw(now);
          vfcId = video.requestVideoFrameCallback(onFrame);
        };
        vfcId = video.requestVideoFrameCallback(onFrame);
      } else {
        const tick = (now) => {
          if (!video.paused) draw(now);
          rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
      }
    }
    function stop() {
      if (vfcId && video?.cancelVideoFrameCallback) video.cancelVideoFrameCallback(vfcId);
      vfcId = 0;
      cancelAnimationFrame(rafId);
      rafId = 0;
    }

    const onSeeked = () => { fresh = true; draw(); };
    const onLoaded = () => { fresh = true; draw(); };

    function attach() {
      const next = source();
      if (next === video) return;
      if (video) {
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("loadeddata", onLoaded);
      }
      stop();
      video = next;
      fresh = true;
      if (!video) return;
      video.addEventListener("seeked", onSeeked);
      video.addEventListener("loadeddata", onLoaded);
      draw();
      loop();
    }

    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    resizeObserver?.observe(stage);
    addEventListener("resize", place);
    place();
    attach();

    return {
      /** 換主鏡頭後呼叫:改從新的主畫面取樣。 */
      refresh() { attach(); fresh = true; draw(); place(); },
      place,
      setEnabled(on) {
        enabled = !!on;
        canvas.hidden = !enabled;
        if (enabled) { fresh = true; place(); draw(); loop(); }
        else stop();
      },
      get enabled() { return enabled; },
      destroy() { stop(); resizeObserver?.disconnect(); removeEventListener("resize", place); },
    };
  }

  window.DashcamAmbient = Object.freeze({ create });
})();
