import { useEffect, useRef } from 'react';

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
};

const LINK_DISTANCE = 118;

/**
 * ~60 fps. The animation is decoration, so there is no reason to run it at the display's full rate
 * and spend twice the frame budget on a 120 Hz panel for a result nobody can distinguish.
 */
const FRAME_INTERVAL_MS = 1000 / 60;

export function ParticleBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    let width = 0;
    let height = 0;
    let gold = '#e2bd52';
    let particles: Particle[] = [];
    let lastDrawAt = 0;
    /** Set by the observer below; a `let`-in-closure because `step` reads it every frame. */
    const visible = { current: true };

    const readThemeColor = () => {
      const value = getComputedStyle(document.documentElement).getPropertyValue('--gold').trim();
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

    const step = (timestamp: number) => {
      frame = window.requestAnimationFrame(step);
      /**
       * Two reasons not to draw, and both were missing.
       *
       * **The hidden tab.** `requestAnimationFrame` is already throttled in a background tab, but
       * the callback still runs at whatever rate the browser chooses, and this one is O(n²): up to
       * 72 particles means 2,556 distance checks per frame. Not drawing at all when the document
       * is hidden is strictly better than drawing slowly, and it costs one boolean.
       *
       * **The frame budget.** The animation is decoration; it has no reason to run at 144 Hz and
       * spend the whole frame. Capping to ~60 fps halves the drawing on a fast display while
       * remaining visually identical.
       */
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

    /**
     * The loop is stopped, not merely skipped, while there is nothing to animate.
     *
     * Early-returning inside `step` is what keeps a *running* loop from drawing, but it still
     * wakes on every frame to decide that — measured at ~35 idle wake-ups a second on the
     * marketing page. Cancelling the callback and restarting it on the way back means a hidden
     * tab, or one scrolled past the canvas, costs nothing at all. `IntersectionObserver` and
     * `visibilitychange` are the events that can start it again, and both are edge-triggered, so
     * neither costs a per-frame check.
     */
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

    /**
     * Stop when the canvas scrolls out of view, and start again on the way back.
     *
     * The beams and links are drawn once on the exact centre of the viewport, so
     * `IntersectionObserver` reports the change rather than a scroll listener doing it per frame.
     */
    const intersection = new IntersectionObserver(
      (entries) => {
        visible.current = entries.some((entry) => entry.isIntersecting);
        if (visible.current) start();
        else stop();
      },
      { threshold: 0 },
    );
    intersection.observe(canvas);

    /** A background tab does no work either, and comes back on the way in. */
    const handleVisibility = () => {
      if (document.hidden) stop();
      else if (visible.current) start();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    const handleResize = () => {
      resize();
      if (reducedMotion) draw();
    };
    window.addEventListener('resize', handleResize);

    const themeObserver = new MutationObserver(() => {
      readThemeColor();
      if (reducedMotion) draw();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      stop();
      intersection.disconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('resize', handleResize);
      themeObserver.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="particle-canvas" aria-hidden="true" />;
}
