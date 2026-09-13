import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

class Video extends EventTarget {
  currentTime = 0;
  duration = 30;
  paused = true;
  seeking = false;
  ended = false;
  readyState = 4;
  error: unknown = null;
  style = { visibility: "" };
  parentElement = { title: "" };
  buffered = { length: 1, start: () => 0, end: () => this.duration };
  playCalls = 0;
  playResult: (() => Promise<void>) | null = null;
  play() {
    this.playCalls++;
    this.paused = false;
    return this.playResult?.() ?? Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {
    this.error = null;
  }
  event(name: string) {
    this.dispatchEvent(new Event(name));
  }
}

function fixture(timeline: unknown = null) {
  const scope: any = { window: {} };
  vm.createContext(scope);
  vm.runInContext(
    fs.readFileSync(new URL("../static/timeline.js", import.meta.url), "utf8"),
    scope,
  );
  scope.DashcamTimeline = scope.window.DashcamTimeline;
  vm.runInContext(
    fs.readFileSync(new URL("../static/playback-sync.js", import.meta.url), "utf8"),
    scope,
  );
  const front = new Video(),
    rear = new Video();
  let main = "front",
    state: any;
  const playback = scope.window.DashcamPlayback.create({
    videos: () => ({ front, rear }),
    main: () => main,
    timeline: () => timeline,
    onState: (next: any) => {
      state = next;
    },
  });
  return {
    front,
    rear,
    playback,
    get state() {
      return state;
    },
    setMain: (next: string) => {
      main = next;
    },
  };
}
const settled = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

for (const camera of ["front", "rear"] as const) {
  test(`${camera} buffering freezes both cameras and resumes together`, async () => {
    const f = fixture();
    f.playback.play();
    await settled();
    f[camera].readyState = 2;
    f[camera].event("waiting");
    assert.equal(f.front.paused, true);
    assert.equal(f.rear.paused, true);
    assert.equal(f.state.buffering, true);
    assert.equal(f.state.waiting[0], camera);
    f[camera].readyState = 4;
    f[camera].event("canplay");
    await settled();
    assert.equal(f.front.paused, false);
    assert.equal(f.rear.paused, false);
    assert.equal(f.state.buffering, false);
    f.playback.destroy();
  });
}

test("manual pause during buffering is not undone by canplay or progress", async () => {
  const f = fixture();
  f.rear.readyState = 2;
  f.playback.play();
  await settled();
  assert.equal(f.state.buffering, true);
  f.playback.toggle();
  f.rear.readyState = 4;
  f.rear.event("canplay");
  f.rear.event("progress");
  f.playback.update();
  assert.equal(f.front.paused, true);
  assert.equal(f.rear.paused, true);
  assert.equal(f.playback.requested, false);
  assert.equal(f.state.buffering, false);
  f.playback.destroy();
});

test("stalled network does not freeze already buffered playback", async () => {
  const f = fixture();
  f.playback.play();
  await settled();
  f.rear.event("stalled");
  assert.equal(f.front.paused, false);
  assert.equal(f.rear.paused, false);
  f.playback.destroy();
});

test("missing footage is hidden, excluded from waiting, and joins when present", async () => {
  const f = fixture({
    front: [{ start: 0, duration: 30, epoch: 100 }],
    rear: [{ start: 0, duration: 10, epoch: 105 }],
  });
  f.rear.readyState = 2;
  f.rear.event("waiting");
  f.playback.play();
  await settled();
  assert.equal(f.front.paused, false);
  assert.equal(f.rear.style.visibility, "hidden");
  assert.equal(f.playback.positionFor("rear"), null);
  f.front.currentTime = 6;
  f.playback.update();
  assert.equal(f.front.paused, true);
  assert.equal(f.rear.currentTime, 1);
  f.rear.readyState = 4;
  f.rear.event("canplay");
  await settled();
  assert.equal(f.front.paused, false);
  assert.equal(f.rear.paused, false);
  assert.equal(f.rear.style.visibility, "");
  f.playback.destroy();
});

test("seeking while playing waits for seek completion; paused seeks never autoplay", async () => {
  const f = fixture();
  f.playback.play();
  await settled();
  f.rear.seeking = true;
  f.playback.seek(8);
  assert.equal(f.front.paused, true);
  assert.equal(f.rear.paused, true);
  f.rear.seeking = false;
  f.rear.event("seeked");
  await settled();
  assert.equal(f.rear.currentTime, 8);
  assert.equal(f.front.paused, false);
  f.playback.pause();
  f.playback.seek(12);
  f.rear.event("canplay");
  assert.equal(f.front.paused, true);
  assert.equal(f.rear.paused, true);
  f.playback.destroy();
});

test("camera switching uses capture-time mapping, not the old camera playback offset", async () => {
  const f = fixture({
    front: [{ start: 0, duration: 30, epoch: 100 }],
    rear: [{ start: 0, duration: 25, epoch: 105 }],
  });
  f.front.currentTime = 10;
  f.playback.play();
  await settled();
  const second = f.playback.positionFor("rear");
  assert.equal(second, 5);
  f.setMain("rear");
  f.playback.seek(second);
  await settled();
  assert.equal(f.rear.currentTime, 5);
  assert.equal(f.front.currentTime, 10);
  assert.equal(f.playback.requested, true);
  f.playback.destroy();
});

test("drift correction freezes the primary rather than repeatedly chasing it", async () => {
  const f = fixture();
  f.playback.play();
  await settled();
  f.front.currentTime = 5;
  f.rear.currentTime = 1;
  f.rear.seeking = true;
  for (let i = 0; i < 20; i++) f.playback.update();
  assert.equal(f.front.paused, true);
  assert.equal(f.rear.currentTime, 1);
  f.rear.seeking = false;
  f.rear.event("seeked");
  await settled();
  assert.equal(f.rear.currentTime, 5);
  assert.equal(f.front.paused, false);
  f.playback.destroy();
});

test("play rejection stops the group and exposes a retryable error", async () => {
  const f = fixture();
  f.rear.playResult = () =>
    Promise.reject(Object.assign(Error("blocked"), { name: "NotAllowedError" }));
  f.playback.play();
  await settled();
  assert.equal(f.front.paused, true);
  assert.equal(f.rear.paused, true);
  assert.match(f.state.error, /後鏡頭/);
  assert.equal(f.playback.requested, false);
  f.rear.playResult = null;
  f.playback.play();
  await settled();
  assert.equal(f.state.error, "");
  assert.equal(f.front.paused, false);
  f.playback.destroy();
});

test("late play completion and late buffer events cannot revive a destroyed player", async () => {
  const f = fixture();
  let resolve!: () => void;
  f.rear.playResult = () =>
    new Promise<void>((r) => {
      resolve = r;
    });
  f.playback.play();
  f.playback.destroy();
  f.rear.paused = false;
  resolve();
  await settled();
  f.rear.event("canplay");
  f.playback.update();
  assert.equal(f.front.paused, true);
  assert.equal(f.rear.paused, true);
});

test("an ended shorter companion is not restarted while the primary finishes", async () => {
  const f = fixture();
  f.front.currentTime = 9.98;
  f.rear.duration = 10;
  f.rear.currentTime = 10;
  f.rear.ended = true;
  f.playback.play();
  await settled();
  assert.equal(f.front.paused, false);
  assert.equal(f.rear.playCalls, 0);
  assert.equal(f.rear.style.visibility, "hidden");
  f.playback.destroy();
});

test("a new paused seek supersedes the companion's unfinished previous seek", () => {
  const f = fixture();
  f.playback.seek(3);
  f.rear.seeking = true;
  f.playback.seek(12);
  assert.equal(f.front.currentTime, 12);
  assert.equal(f.rear.currentTime, 12);
  f.rear.seeking = false;
  f.rear.event("seeked");
  assert.equal(f.front.paused, true);
  assert.equal(f.rear.paused, true);
  f.playback.destroy();
});

test("expected AbortError from a buffering pause does not become a playback failure", async () => {
  const f = fixture();
  f.rear.readyState = 2;
  f.rear.playResult = () =>
    Promise.reject(Object.assign(Error("interrupted"), { name: "AbortError" }));
  f.playback.play();
  await settled();
  assert.equal(f.state.error, "");
  f.rear.playResult = null;
  f.rear.readyState = 4;
  f.rear.event("canplay");
  await settled();
  assert.equal(f.front.paused, false);
  assert.equal(f.rear.paused, false);
  f.playback.destroy();
});
