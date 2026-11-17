"use client";

import {
  forwardRef,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type RefObject,
} from "react";
import type { WordPrediction } from "@/hooks/useWordPrediction";

// Textarea properties that decide where each character lands; the mirror copies
// them so the ghost suffix paints exactly after the caret.
const LAYOUT_PROPS = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "wordSpacing",
  "lineHeight",
  "textIndent",
  "textTransform",
  "tabSize",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "whiteSpace",
  "overflowWrap",
  "wordBreak",
] as const;

interface Props {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  prediction: WordPrediction;
  /** Current draft; a ghost predicted for any other text is stale and hidden. */
  value: string;
}

// The textarea remains the editable, selectable source of truth. This mirror
// paints only backgrounds and ghost text, without changing character metrics.
const TOKENS =
  /`{3,}[\s\S]*?`{3,}|`[^`\n]+`|(?<!\S)@(?:"[^"\n]+"(?::\d+(?:-\d+)?)?|[^\s`]+)|(?<!\S)\/[a-zA-Z][\w:-]*/g;

function highlightedText(text: string, cursor: number | null, suffix: string) {
  const nodes: React.ReactNode[] = [];
  let offset = 0;
  let ghostInserted = false;
  const append = (start: number, end: number, kind?: "mention" | "code") => {
    const render = (from: number, to: number) => {
      if (from === to) return;
      const content = text.slice(from, to);
      nodes.push(
        kind ? (
          <span
            key={`${from}-${to}`}
            style={{
              background:
                kind === "code" ? "var(--bg-hover)" : "var(--bg-selected)",
              borderRadius: 4,
              boxDecorationBreak: "clone",
            }}
          >
            {content}
          </span>
        ) : (
          content
        ),
      );
    };
    if (!ghostInserted && cursor !== null && cursor >= start && cursor <= end) {
      render(start, cursor);
      nodes.push(
        <span key="ghost" style={{ color: "var(--text-dim)" }}>
          {suffix}
        </span>,
      );
      ghostInserted = true;
      render(cursor, end);
    } else render(start, end);
  };
  for (const match of text.matchAll(TOKENS)) {
    const start = match.index;
    append(offset, start);
    const token = match[0];
    append(
      start,
      start + token.length,
      token.startsWith("```")
        ? undefined
        : token.startsWith("`")
          ? "code"
          : "mention",
    );
    offset = start + token.length;
  }
  append(offset, text.length);
  if (!ghostInserted && cursor === text.length)
    nodes.push(
      <span key="ghost" style={{ color: "var(--text-dim)" }}>
        {suffix}
      </span>,
    );
  nodes.push("\u200b");
  return nodes;
}

/** Paint draft highlights and prediction behind the native textarea. */
export const GhostMirror = forwardRef<HTMLDivElement, Props>(
  function GhostMirror({ textareaRef, prediction, value }, ref) {
    const localRef = useRef<HTMLDivElement | null>(null);
    const ghost = useSyncExternalStore(
      prediction.subscribe,
      prediction.peek,
      () => null,
    );
    const visible = ghost !== null && ghost.text === value;

    useLayoutEffect(() => {
      const mirror = localRef.current;
      const textarea = textareaRef.current;
      if (!mirror || !textarea) return;
      const sync = () => {
        const computed = getComputedStyle(textarea);
        for (const prop of LAYOUT_PROPS) mirror.style[prop] = computed[prop];
        // clientWidth excludes the scrollbar, so wrapping matches the textarea's.
        mirror.style.width = `${textarea.clientWidth}px`;
        mirror.style.height = `${textarea.clientHeight}px`;
        mirror.scrollTop = textarea.scrollTop;
        mirror.scrollLeft = textarea.scrollLeft;
      };
      sync();
      const observer = new ResizeObserver(sync);
      observer.observe(textarea);
      return () => observer.disconnect();
    });

    if (!value && !visible) return null;
    return (
      <div
        ref={(el) => {
          localRef.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
        aria-hidden="true"
        data-testid="composer-ghost"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          boxSizing: "border-box",
          overflow: "hidden",
          pointerEvents: "none",
          color: "transparent",
        }}
      >
        {highlightedText(
          value,
          visible ? ghost.cursor : null,
          visible ? ghost.suffix : "",
        )}
      </div>
    );
  },
);
