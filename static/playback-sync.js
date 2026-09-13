/* Shared playback intent and buffering barrier. A paused element is not necessarily a user pause. */
window.DashcamPlayback = (() => {
  const cameraName = (camera) => (camera === "front" ? "前鏡頭" : "後鏡頭");

  function create({ videos, main, timeline, onState = () => {}, stage }) {
    let intent = false,
      held = false,
      destroyed = false,
      error = "",
      lastState = "";
    let updating = false,
      generation = 0;
    const waiting = new Set(),
      pending = new Map(),
      listeners = [];
    const entries = () => Object.entries(videos());
    const status = stage ? document.createElement("div") : null;
    if (status) {
      status.className = "playback-status";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      status.hidden = true;
      stage.appendChild(status);
    }

    function positionFor(camera) {
      const primary = videos()[main()],
        video = videos()[camera];
      if (!primary || !video) return null;
      if (camera === main()) return primary.currentTime;
      const second = DashcamTimeline.position(timeline(), main(), camera, primary.currentTime);
      if (second === null || second < 0) return null;
      return Number.isFinite(video.duration) &&
        (second >= video.duration || (video.ended && second >= video.duration - 0.05))
        ? null
        : second;
    }

    function required() {
      return entries().filter(([camera, video]) => {
        const present = positionFor(camera) !== null;
        video.style.visibility = present ? "" : "hidden";
        if (video.parentElement) video.parentElement.title = present ? "" : "此時段缺少鏡頭影片";
        if (!present && !video.paused) video.pause();
        return present;
      });
    }

    function ready(video) {
      if (video.error || video.seeking || video.readyState < 3) return false;
      // A small buffer margin avoids resuming for a single frame and immediately stalling again.
      const margin = Math.min(0.3, Math.max(0, video.duration - video.currentTime - 0.025));
      for (let i = 0; i < video.buffered.length; i++) {
        if (
          video.buffered.start(i) <= video.currentTime + 0.01 &&
          video.buffered.end(i) >= video.currentTime + margin
        )
          return true;
      }
      return false;
    }

    function emit(blockers = []) {
      const state = { intent, buffering: intent && held, waiting: blockers, error };
      const key = JSON.stringify(state);
      if (key === lastState) return;
      lastState = key;
      if (status) {
        status.hidden = !state.buffering && !error;
        status.dataset.state = error ? "error" : "buffering";
        status.textContent =
          error || `等待${blockers.map(cameraName).join("、") || "影片"}緩衝，畫面已一起暫停`;
      }
      onState(state);
    }

    function pauseElements() {
      for (const [, video] of entries()) if (!video.paused) video.pause();
    }

    function fail(camera) {
      intent = false;
      held = false;
      generation++;
      error = `${cameraName(camera)}無法播放。請檢查網路後按播放重試，或重新載入頁面。`;
      pauseElements();
      emit();
    }

    function start(camera, video) {
      if (!intent || !video.paused || pending.has(video)) return;
      const attempt = { generation };
      pending.set(video, attempt);
      let result;
      try {
        result = video.play();
      } catch {
        pending.delete(video);
        fail(camera);
        return;
      }
      Promise.resolve(result).then(
        () => {
          if (destroyed) {
            video.pause();
            return;
          }
          if (pending.get(video) !== attempt) return;
          pending.delete(video);
          if (destroyed || !intent || held || positionFor(camera) === null) video.pause();
        },
        (reason) => {
          if (pending.get(video) !== attempt) return;
          pending.delete(video);
          if (destroyed || !intent || attempt.generation !== generation) return;
          // pause()/seek() deliberately interrupts pending play requests during the barrier.
          if (reason?.name !== "AbortError") fail(camera);
        },
      );
    }

    function align(active, force = false) {
      for (const [camera, video] of active) {
        if (camera === main() || video.seeking) continue;
        const second = positionFor(camera);
        if (second !== null && Math.abs(video.currentTime - second) > (force ? 0.001 : 0.12))
          video.currentTime = second;
      }
    }

    function update() {
      if (destroyed || updating) return;
      updating = true;
      try {
        const active = required();
        if (!intent) {
          emit();
          return;
        }
        const broken = active.find(([, video]) => video.error);
        if (broken) {
          fail(broken[0]);
          return;
        }
        const drift = active.some(
          ([camera, video]) =>
            camera !== main() && Math.abs(video.currentTime - positionFor(camera)) > 0.25,
        );
        let blockers = active.filter(([camera, video]) => waiting.has(camera) || !ready(video));
        if (blockers.length || drift) {
          held = true;
          pauseElements(); // Freeze the clock before seeking: never chase a moving primary during buffering.
          align(active);
          blockers = active.filter(([camera, video]) => waiting.has(camera) || !ready(video));
          if (blockers.length) {
            emit(blockers.map(([camera]) => camera));
            return;
          }
        }
        held = false;
        for (const [camera, video] of active) start(camera, video);
        emit();
      } finally {
        updating = false;
      }
    }

    function play() {
      if (destroyed) return;
      intent = true;
      error = "";
      generation++;
      const active = required();
      align(active, true);
      for (const [camera, video] of active) {
        video.preload = "auto";
        if (video.error) {
          waiting.delete(camera);
          video.load();
        }
        start(camera, video); // Prime all streams in the original user gesture, including unmuted audio.
      }
      update();
    }

    function pause() {
      intent = false;
      held = false;
      generation++;
      pauseElements();
      emit();
    }

    function seek(second) {
      const primary = videos()[main()];
      if (!primary || !Number.isFinite(second)) return;
      generation++;
      held = intent;
      pauseElements();
      waiting.clear();
      primary.currentTime = Math.max(
        0,
        Number.isFinite(primary.duration) ? Math.min(second, primary.duration) : second,
      );
      align(required(), true);
      update();
    }

    for (const [camera, video] of entries()) {
      const listen = (type, handler) => {
        video.addEventListener(type, handler);
        listeners.push(() => video.removeEventListener(type, handler));
      };
      listen("waiting", () => {
        waiting.add(camera);
        update();
      });
      listen("stalled", update); // Network inactivity alone is harmless while sufficient data remains buffered.
      for (const type of ["canplay", "playing", "progress", "loadeddata", "seeked"]) {
        listen(type, () => {
          if (ready(video)) waiting.delete(camera);
          update();
        });
      }
      listen("seeking", update);
      listen("pause", update);
      listen("error", update);
      listen("ended", () => {
        if (camera === main()) pause();
        else update();
      });
    }

    return {
      play,
      pause,
      seek,
      update,
      positionFor,
      toggle() {
        if (intent) pause();
        else play();
      },
      get requested() {
        return intent;
      },
      destroy() {
        destroyed = true;
        intent = false;
        generation++;
        for (const remove of listeners) remove();
        pauseElements();
        pending.clear();
        status?.remove();
      },
    };
  }
  return Object.freeze({ create });
})();
