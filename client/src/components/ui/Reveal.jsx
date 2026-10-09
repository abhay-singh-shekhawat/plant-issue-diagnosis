import React, { useEffect, useRef } from 'react';
import { gsap } from 'gsap';

// Motivated ingress only: opacity + 8px rise, 220ms, stagger via delay prop.
// Reduced motion collapses to instant. gsap.context with revert cleanup.
const Reveal = ({ children, delay = 0, className = '' }) => {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const ctx = gsap.context(() => {
      gsap.from(el, {
        opacity: 0,
        y: 8,
        duration: 0.22,
        delay,
        ease: 'power1.out',
        clearProps: 'all',
      });
    }, el);
    return () => ctx.revert();
  }, [delay]);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
};

export default Reveal;
