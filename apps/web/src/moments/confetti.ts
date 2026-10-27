/**
 * A short confetti burst on a canvas over the page: pointer-events off, hidden from screen
 * readers, gone in under two seconds. Colours come from the look's accents, so every look
 * celebrates in its own palette. The pattern comes from a seed (no Math.random), so the same
 * moment throws the same confetti.
 */
import type { Confetti } from "./catalog.ts";

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  vr: number;
  w: number;
  h: number;
  color: string;
}

function rng(seed: string): () => number {
  let a = 0;
  for (let i = 0; i < seed.length; i++) a = (Math.imul(a, 31) + seed.charCodeAt(i)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function palette(): string[] {
  const css = getComputedStyle(document.documentElement);
  const colors = ["--c-a1", "--c-a2", "--c-a3", "--c-warning", "--c-success"]
    .map((v) => css.getPropertyValue(v).trim())
    .filter(Boolean);
  return colors.length ? colors : ["#3D5AFE", "#0B7A55", "#7C3AED", "#FFB020"];
}

export function throwConfetti(size: Confetti, seed: string): void {
  if (size === "none" || typeof document === "undefined") return;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext?.("2d");
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.className = "moment-confetti";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);
  ctx.scale(dpr, dpr);

  const rand = rng(seed);
  const colors = palette();
  const count = size === "big" ? 160 : 70;
  // Small bursts rise from the bottom centre; big ones rain across the whole width.
  const pieces: Piece[] = Array.from({ length: count }, () => {
    const big = size === "big";
    const angle = big ? Math.PI / 2 + (rand() - 0.5) * 0.6 : -Math.PI / 2 + (rand() - 0.5) * 1.3;
    const speed = big ? 2 + rand() * 3 : 9 + rand() * 7;
    return {
      x: big ? rand() * width : width / 2 + (rand() - 0.5) * 80,
      y: big ? -20 - rand() * height * 0.3 : height * 0.85,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      r: rand() * Math.PI,
      vr: (rand() - 0.5) * 0.3,
      w: 6 + rand() * 6,
      h: 8 + rand() * 8,
      color: colors[Math.floor(rand() * colors.length)] ?? "#3D5AFE",
    };
  });

  const duration = size === "big" ? 2200 : 1500;
  const start = performance.now();
  const frame = (now: number) => {
    const t = now - start;
    ctx.clearRect(0, 0, width, height);
    ctx.globalAlpha = t > duration - 400 ? Math.max(0, (duration - t) / 400) : 1;
    for (const p of pieces) {
      p.vy += 0.25;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
      ctx.restore();
    }
    if (t < duration) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}
