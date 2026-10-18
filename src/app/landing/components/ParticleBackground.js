"use client";

import { useEffect, useRef } from "react";

const LINK_DISTANCE = 118;
const FRAME_INTERVAL_MS = 1000 / 60;

/**
 * Canvas particle field. Capped at ~60 fps; stops entirely when the tab is
 * hidden or the canvas scrolls out of view, and draws once under reduced motion.
 */
export default function ParticleBackground() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let width = 0;
    let height = 0;
    let gold = "#e2bd52";
    let particles = [];
    let lastDrawAt = 0;
    const visible = { current: true };

    const readThemeColor = () => {
      const value = getComputedStyle(document.documentElement).getPropertyValue("--gold").trim();
      if (value) gold = value;
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = Math.min(72, Math.max(24, Math.round((width * height) / 28000)));
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.2,
        vy: (Math.random() - 0.5) * 0.2,
        radius: Math.random() * 1.4 + 0.55,
      }));
    };

    const draw = () => {
      context.clearRect(0, 0, width, height);
      context.lineWidth = 1;
      context.strokeStyle = gold;

      for (let i = 0; i < particles.length; i += 1) {
        for (let j = i + 1; j < particles.length; j += 1) {
          const first = particles[i];
          const second = particles[j];
          const distance = Math.hypot(first.x - second.x, first.y - second.y);
          if (distance >= LINK_DISTANCE) continue;

          context.globalAlpha = (1 - distance / LINK_DISTANCE) * 0.25;
          context.beginPath();
          context.moveTo(first.x, first.y);
          context.lineTo(second.x, second.y);
          context.stroke();
        }
      }

      context.fillStyle = gold;
      context.globalAlpha = 0.62;
      for (const particle of particles) {
        context.beginPath();
        context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
    };

    const step = (timestamp) => {
      frame = window.requestAnimationFrame(step);
      if (document.hidden) return;
      if (!visible.current) return;
      if (timestamp - lastDrawAt < FRAME_INTERVAL_MS) return;
      lastDrawAt = timestamp;

      for (const particle of particles) {
        particle.x += particle.vx;
        particle.y += particle.vy;
        if (particle.x < 0 || particle.x > width) particle.vx *= -1;
        if (particle.y < 0 || particle.y > height) particle.vy *= -1;
      }
      draw();
    };

    const start = () => {
      if (reducedMotion || frame) return;
      frame = window.requestAnimationFrame(step);
    };
    const stop = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
    };

    readThemeColor();
    resize();
    if (reducedMotion) draw();
    else start();

    const intersection = new IntersectionObserver(
      (entries) => {
        visible.current = entries.some((entry) => entry.isIntersecting);
        if (visible.current) start();
        else stop();
      },
      { threshold: 0 }
    );
    intersection.observe(canvas);

    const handleVisibility = () => {
      if (document.hidden) stop();
      else if (visible.current) start();
    };
    document.addEventListener("visibilitychange", handleVisibility);

    const handleResize = () => {
      resize();
      if (reducedMotion) draw();
    };
    window.addEventListener("resize", handleResize);

    const themeObserver = new MutationObserver(() => {
      readThemeColor();
      if (reducedMotion) draw();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });

    return () => {
      stop();
      intersection.disconnect();
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("resize", handleResize);
      themeObserver.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="particle-canvas" aria-hidden="true" />;
}
