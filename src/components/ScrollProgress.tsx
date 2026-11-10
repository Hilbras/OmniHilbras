import { motion, useReducedMotion, useScroll, useSpring } from 'motion/react';

/** A thin gold line that follows the reading position; transform-only, so it stays off the main thread. */
export function ScrollProgress() {
  const reduceMotion = useReducedMotion();
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 120, damping: 30, restDelta: 0.001 });
  if (reduceMotion) return null;
  return <motion.div aria-hidden="true" style={{ scaleX }} className="fixed inset-x-0 top-0 z-[60] h-[2px] origin-left bg-gold" />;
}
