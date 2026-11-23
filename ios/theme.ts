// The PWA's OMP Midnight palette, used for native dark appearance.
export const theme = {
  background: "#000000",
  panel: "#0A0A0C",
  hover: "#141417",
  border: "#232329",
  text: "#F5F5F5",
  muted: "#C9C9D1",
  accent: "#EC5BAB",
} as const;

// Native appearance follows iOS; the PWA stores its theme separately.
export const lightTheme = {
  background: "#FAF9F6",
  panel: "#F2F0EA",
  hover: "#EAE7DF",
  border: "#E2DDD2",
  text: "#2B2823",
  muted: "#69635A",
  accent: "#B03E22",
} as const;
