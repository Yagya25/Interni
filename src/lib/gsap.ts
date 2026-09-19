"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

// Register once, on the client. Every module that animates imports from here
// so plugin registration can never be forgotten or duplicated.
if (typeof window !== "undefined") {
  gsap.registerPlugin(ScrollTrigger, useGSAP);
  // Mobile browsers resize the viewport when the toolbar shows or hides.
  // Re-measuring on those events causes visible jumps in pinned scenes.
  ScrollTrigger.config({ ignoreMobileResize: true });
}

export { gsap, ScrollTrigger, useGSAP };
