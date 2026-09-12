/* One browser mapping for authenticated and shared playback. Missing media is never invented. */
window.DashcamTimeline = Object.freeze({
  position(timeline, source, target, second) {
    if (!timeline) return second; // Legacy metadata without a timeline.
    const spans = timeline[source] || [];
    const span =
      spans.find((s) => second >= s.start && second < s.start + s.duration) ||
      spans.findLast((s) => Math.abs(second - s.start - s.duration) < 0.001);
    if (!span) return null;
    const epoch = span.epoch + second - span.start;
    const destination = (timeline[target] || []).find(
      (s) => epoch >= s.epoch && epoch < s.epoch + s.duration,
    );
    return destination ? destination.start + epoch - destination.epoch : null;
  },
  sync(timeline, source, target, primary, companion, force = false) {
    const position = this.position(timeline, source, target, primary.currentTime);
    companion.style.visibility = position === null ? "hidden" : "";
    companion.parentElement.title = position === null ? "此時段缺少鏡頭影片" : "";
    if (position !== null && (force || Math.abs(companion.currentTime - position) > 0.25))
      companion.currentTime = position;
  },
});
