'use client';
import { useEffect, useRef, useState } from 'react';

export function useBoardFullscreen() {
  const ref = useRef<HTMLElement>(null);
  const [native, setNative] = useState(false);
  const [windowMode, setWindowMode] = useState(false);
  useEffect(() => {
    const changed = () => setNative(document.fullscreenElement === ref.current);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  useEffect(() => {
    if (!windowMode) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setWindowMode(false);
    };
    document.addEventListener('keydown', escape);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', escape);
    };
  }, [windowMode]);
  async function toggle() {
    if (windowMode) {
      setWindowMode(false);
      return;
    }
    try {
      if (document.fullscreenElement === ref.current) await document.exitFullscreen();
      else if (ref.current?.requestFullscreen) await ref.current.requestFullscreen();
      else setWindowMode(true);
    } catch {
      // Some mobile browsers and embedded windows only allow filling their viewport.
      setWindowMode(true);
    }
  }
  return { ref, active: native || windowMode, windowMode, toggle };
}
