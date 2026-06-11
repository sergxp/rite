import { useState, useEffect } from "react";

export const SPINNER_FRAMES = ["|", "/", "-", "\\", "|", "/", "-", "\\", "|", "/"];
const INTERVAL_MS = 80;

// Module-level singleton so all subscribers share one setInterval → one React render per tick.
let frame = 0;
let intervalId: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<(f: number) => void>();

function start() {
  if (intervalId !== null) return;
  intervalId = setInterval(() => {
    frame = (frame + 1) % SPINNER_FRAMES.length;
    for (const cb of subscribers) cb(frame);
  }, INTERVAL_MS);
}

function stop() {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
    frame = 0;
  }
}

export function useSpinnerFrame(): number {
  const [f, setF] = useState(0);

  useEffect(() => {
    subscribers.add(setF);
    if (subscribers.size === 1) start();
    return () => {
      subscribers.delete(setF);
      if (subscribers.size === 0) stop();
    };
  }, []);

  return f;
}

// Subscribe a raw callback to every tick. Fires in the same synchronous loop as
// useSpinnerFrame setters, so React 18 batches all updates into one render commit.
export function subscribeTick(cb: (frame: number) => void): () => void {
  subscribers.add(cb);
  if (subscribers.size === 1) start();
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0) stop();
  };
}
