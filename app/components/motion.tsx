"use client";

import { useRef, type ReactNode } from "react";
import { gsap, useGSAP } from "./gsap";

function animateEntrance(element: HTMLElement, axis: "x" | "y") {
  const media = gsap.matchMedia();
  media.add(
    { reduceMotion: "(prefers-reduced-motion: reduce)" },
    (context) => {
      const reduceMotion = Boolean(context.conditions?.reduceMotion);
      const offset = reduceMotion ? 0 : 8;
      gsap.fromTo(
        element,
        { autoAlpha: reduceMotion ? 1 : 0, [axis]: offset },
        {
          autoAlpha: 1,
          [axis]: 0,
          duration: reduceMotion ? 0 : 0.24,
          ease: "power2.out",
          clearProps: "transform,opacity,visibility",
        },
      );
    },
  );
  return () => media.revert();
}

export function PanelMotion({
  children,
  motionKey,
  className = "",
}: {
  children: ReactNode;
  motionKey: string;
  className?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (!panelRef.current) return;
      return animateEntrance(panelRef.current, "x");
    },
    { dependencies: [motionKey], scope: panelRef, revertOnUpdate: true },
  );

  return (
    <div className={className} ref={panelRef}>
      {children}
    </div>
  );
}
