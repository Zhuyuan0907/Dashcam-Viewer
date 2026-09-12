(() => {
  const PLAY_PATH = 'M8 5v14l11-7z';
  const PAUSE_PATH = 'M6 5h4v14H6zM14 5h4v14h-4z';

  function setPlaybackState(button, playing) {
    if (!button) return;
    const path = button.querySelector('[data-playback-icon] path');
    if (path) path.setAttribute('d', playing ? PAUSE_PATH : PLAY_PATH);
    const label = playing
      ? (button.dataset.pauseLabel || '暫停')
      : (button.dataset.playLabel || '播放');
    button.dataset.playing = playing ? 'true' : 'false';
    button.setAttribute('aria-label', label);
  }

  function bindPreciseSeek({ track, input, fill, onSeek }) {
    let pointerId = null;
    let keyboardSeeking = false;
    let settling = false;
    let settleTimer = null;

    const clamp = value => Math.max(0, Math.min(100, Number(value) || 0));
    const draw = value => {
      const percent = clamp(value);
      input.value = String(percent);
      fill.style.width = `${percent}%`;
      input.setAttribute('aria-valuenow', String(Math.round(percent * 100) / 100));
      return percent;
    };
    const startSettling = () => {
      settling = true;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => { settling = false; }, 1500);
    };
    const apply = (value, commit = false) => {
      const percent = draw(value);
      onSeek(percent);
      if (commit) startSettling();
    };
    const fromPointer = event => {
      const rect = track.getBoundingClientRect();
      if (!rect.width) return 0;
      return (event.clientX - rect.left) / rect.width * 100;
    };

    track.addEventListener('pointerdown', event => {
      if (event.button !== undefined && event.button !== 0) return;
      pointerId = event.pointerId;
      keyboardSeeking = false;
      input.focus({ preventScroll: true });
      try { track.setPointerCapture(pointerId); } catch {}
      event.preventDefault();
      apply(fromPointer(event));
    });
    track.addEventListener('pointermove', event => {
      if (pointerId !== event.pointerId) return;
      event.preventDefault();
      apply(fromPointer(event));
    });
    const finishPointer = event => {
      if (pointerId !== event.pointerId) return;
      event.preventDefault();
      apply(fromPointer(event), true);
      try { track.releasePointerCapture(pointerId); } catch {}
      pointerId = null;
    };
    track.addEventListener('pointerup', finishPointer);
    track.addEventListener('pointercancel', event => {
      if (pointerId !== event.pointerId) return;
      try { track.releasePointerCapture(pointerId); } catch {}
      pointerId = null;
      startSettling();
    });

    input.addEventListener('input', () => {
      if (pointerId !== null) return;
      keyboardSeeking = true;
      apply(input.value);
    });
    const finishKeyboard = () => {
      if (!keyboardSeeking) return;
      keyboardSeeking = false;
      startSettling();
    };
    input.addEventListener('change', finishKeyboard);
    input.addEventListener('keyup', finishKeyboard);
    input.addEventListener('blur', finishKeyboard);

    return {
      get seeking() { return pointerId !== null || keyboardSeeking || settling; },
      render(value) {
        if (pointerId === null && !keyboardSeeking && !settling) draw(value);
      },
      settled() {
        if (pointerId !== null || keyboardSeeking) return;
        settling = false;
        clearTimeout(settleTimer);
      },
    };
  }

  window.DashcamPlayerControls = { bindPreciseSeek, setPlaybackState };
})();
