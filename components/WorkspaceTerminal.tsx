"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  EVENT_STREAM_CLOSED,
  openEventStream,
  type EventStream,
} from "@/lib/event-stream";
import { terminalCommand, terminalSnapshot } from "@/lib/terminal-client";
import { applyTerminalControl } from "@/lib/terminal-control";
import type {
  TerminalEvent,
  WorkspaceTerminal as TerminalInfo,
} from "@/lib/terminal-types";

export function WorkspaceTerminal({
  terminal,
  hostId,
  active,
}: {
  terminal: TerminalInfo;
  hostId: string;
  active: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const sendKeyRef = useRef<((key: string) => void) | null>(null);
  const ctrlRef = useRef(false);
  const [ctrl, setCtrl] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const term = new Terminal({
      cols: terminal.cols,
      rows: terminal.rows,
      cursorBlink: true,
      fontFamily:
        '"JetBrains Mono Variable", "Symbols Nerd Font Mono", monospace',
      fontSize: 13,
      scrollback: 10000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    // The daemon answers terminal queries, including while no tab is attached.
    for (const prefix of [undefined, ">"] as const)
      term.parser.registerCsiHandler({ prefix, final: "c" }, () => true);
    for (const prefix of [undefined, "?"] as const)
      term.parser.registerCsiHandler({ prefix, final: "n" }, () => true);
    for (const prefix of [undefined, "?"] as const)
      term.parser.registerCsiHandler(
        { prefix, intermediates: "$", final: "p" },
        () => true,
      );
    term.parser.registerDcsHandler(
      { intermediates: "$", final: "q" },
      () => true,
    );
    // xterm 6's internal core service retains the user-input flag that its
    // public onData event omits. Filter generated replies here so color sets
    // stay in parser order and literal pasted escape sequences remain input.
    const terminalCore = term as unknown as {
      _core: {
        coreService: {
          triggerDataEvent: (data: string, wasUserInput?: boolean) => void;
        };
      };
    };
    const coreService = terminalCore._core.coreService;
    const triggerDataEvent = coreService.triggerDataEvent;
    coreService.triggerDataEvent = function (data, wasUserInput) {
      if (
        !wasUserInput &&
        (/^\x1b\](?:4;\d+|10|11|12);rgb:[^\x1b]*\x1b\\$/.test(data) ||
          data === "\x1b[I" ||
          data === "\x1b[O")
      )
        return;
      triggerDataEvent.call(this, data, wasUserInput);
    };
    const viewer = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    let focused = false;
    let focusDirty = false;
    let focusSending = false;
    const sendFocus = () => {
      focusDirty = true;
      if (focusSending) return;
      focusSending = true;
      void (async () => {
        while (focusDirty) {
          focusDirty = false;
          const current = focused;
          try {
            await terminalCommand(terminal.id, hostId, {
              action: "focus",
              viewer,
              focused: current,
            });
          } catch {
            // A later heartbeat or reconnect will renew the lease.
          }
        }
        focusSending = false;
      })();
    };
    const updateFocus = (value: boolean) => {
      if (focused === value) return;
      focused = value;
      sendFocus();
    };
    const onFocusIn = () => updateFocus(document.hasFocus());
    const onFocusOut = (event: FocusEvent) => {
      if (
        !(event.relatedTarget instanceof Node) ||
        !element.contains(event.relatedTarget)
      )
        updateFocus(false);
    };
    const onWindowFocus = () =>
      updateFocus(element.contains(document.activeElement));
    const onWindowBlur = () => updateFocus(false);
    element.addEventListener("focusin", onFocusIn);
    element.addEventListener("focusout", onFocusOut);
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("blur", onWindowBlur);
    const focusHeartbeat = setInterval(() => {
      if (focused) sendFocus();
    }, 5000);
    const applyTheme = () => {
      const style = getComputedStyle(document.documentElement);
      term.options.theme = {
        background: style.getPropertyValue("--bg-panel").trim(),
        foreground: style.getPropertyValue("--text").trim(),
        cursor: style.getPropertyValue("--text").trim(),
      };
    };
    applyTheme();
    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    let disposed = false;
    let ready = false;
    let replayingSnapshot = false;
    let generation = 0;
    let cursor = 0;
    let buffered: Extract<TerminalEvent, { type: "output" | "resize" }>[] = [];
    let remoteResize = false;
    let bufferedBytes = 0;
    let retry: NodeJS.Timeout | undefined;
    let pendingInput = "";
    let pendingResize: { cols: number; rows: number } | null = null;
    let sending = false;
    const flush = async () => {
      if (sending || !ready) return;
      sending = true;
      while (ready && (pendingInput || pendingResize)) {
        let end = Math.min(pendingInput.length, 16000);
        if (
          end < pendingInput.length &&
          end > 0 &&
          /[\uD800-\uDBFF]/.test(pendingInput[end - 1])
        )
          end--;
        const command = pendingInput
          ? { action: "input" as const, data: pendingInput.slice(0, end) }
          : { action: "resize" as const, ...pendingResize! };
        if (command.action === "input")
          pendingInput = pendingInput.slice(command.data.length);
        else pendingResize = null;
        try {
          await terminalCommand(terminal.id, hostId, command);
        } catch (err) {
          if (disposed) break;
          ready = false;
          pendingInput = "";
          setError(
            `Terminal input failed and may not have been delivered: ${err instanceof Error ? err.message : String(err)}. Reconnecting…`,
          );
          retry = setTimeout(sync, 1000);
          pendingResize = null;
          break;
        }
      }
      sending = false;
    };
    const resize = () => {
      if (!ready || !element.clientWidth || !element.clientHeight) return;
      fit.fit();
    };
    fitRef.current = () => {
      resize();
      term.focus();
    };
    const sendInput = (data: string) => {
      if (replayingSnapshot) return;
      if (!ready) {
        setError(
          "Terminal disconnected. Input is unavailable until reconnected.",
        );
        return;
      }
      if (pendingInput.length + data.length > 1024 * 1024) {
        setError(
          "Terminal input buffer full; wait for the host before typing more.",
        );
        return;
      }
      pendingInput += data;
      void flush();
    };
    const input = term.onData((data) => {
      const encoded = applyTerminalControl(data, ctrlRef.current);
      if (encoded.consumed) {
        ctrlRef.current = false;
        setCtrl(false);
      }
      sendInput(encoded.data);
    });
    sendKeyRef.current = (key) => {
      const arrows: Record<string, string> = {
        Up: "A",
        Down: "B",
        Right: "C",
        Left: "D",
      };
      if (arrows[key]) {
        const modifier = ctrlRef.current ? ";5" : "";
        sendInput(
          modifier
            ? `\x1b[1${modifier}${arrows[key]}`
            : `\x1b${term.modes.applicationCursorKeysMode ? "O" : "["}${arrows[key]}`,
        );
      } else {
        sendInput(
          (
            { Esc: "\x1b", Tab: "\t", "Ctrl-C": "\x03" } as Record<
              string,
              string
            >
          )[key],
        );
      }
      ctrlRef.current = false;
      setCtrl(false);
      term.focus();
    };
    const sizes = term.onResize(({ cols, rows }) => {
      if (ready && !remoteResize) {
        pendingResize = { cols, rows };
        void flush();
      }
    });
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    let stream: EventStream;
    const applyEvent = (
      event: Extract<TerminalEvent, { type: "output" | "resize" }>,
    ) => {
      if (event.cursor <= cursor) return true;
      if (event.cursor !== cursor + 1) return false;
      cursor = event.cursor;
      if (event.type === "output") term.write(event.data);
      else {
        remoteResize = true;
        term.resize(event.cols, event.rows);
        remoteResize = false;
      }
      return true;
    };
    const sync = () => {
      if (disposed) return;
      clearTimeout(retry);
      const current = ++generation;
      ready = false;
      buffered = [];
      bufferedBytes = 0;
      void terminalSnapshot(terminal.id, hostId)
        .then((state) => {
          if (disposed || current !== generation) return;
          term.reset();
          term.resize(state.terminal.cols, state.terminal.rows);
          cursor = state.cursor;
          replayingSnapshot = true;
          term.write(state.snapshot, () => {
            if (disposed || current !== generation) return;
            replayingSnapshot = false;
            for (const event of buffered) {
              if (!applyEvent(event)) {
                sync();
                return;
              }
            }
            buffered = [];
            bufferedBytes = 0;
            ready = true;
            setError(null);
            resize();
            void flush();
            if (focused) sendFocus();
          });
        })
        .catch((err) => {
          if (disposed || current !== generation) return;
          setError(
            `Terminal reconnecting: ${err instanceof Error ? err.message : String(err)}`,
          );
          retry = setTimeout(sync, 1000);
        });
    };
    const subscribe = () => {
      stream = openEventStream({
        kind: "terminal",
        hostId,
        terminalId: terminal.id,
      });
      stream.onopen = sync;
      stream.onmessage = ({ data }) => {
        let event: TerminalEvent;
        try {
          event = JSON.parse(data) as TerminalEvent;
        } catch {
          return;
        }
        if (event.type === "closed") {
          generation++;
          ready = false;
          clearTimeout(retry);
          setError("Terminal has closed.");
          return;
        }
        if (event.type === "disconnected") {
          generation++;
          ready = false;
          clearTimeout(retry);
          stream.close();
          setError("Terminal disconnected. Reconnecting…");
          retry = setTimeout(subscribe, 1000);
          return;
        }
        if (event.type !== "output" && event.type !== "resize") return;
        if (!ready) {
          bufferedBytes += event.type === "output" ? event.data.length : 32;
          if (bufferedBytes > 1024 * 1024) {
            clearTimeout(retry);
            sync();
          } else buffered.push(event);
        } else if (!applyEvent(event)) sync();
      };
      stream.onerror = () => {
        generation++;
        clearTimeout(retry);
        ready = false;
        setError("Terminal disconnected. Reconnecting…");
        if (stream.readyState === EVENT_STREAM_CLOSED && !disposed)
          retry = setTimeout(subscribe, 1000);
      };
    };
    subscribe();
    void document.fonts.ready.then(() => {
      if (!disposed) resize();
    });
    return () => {
      disposed = true;
      clearInterval(focusHeartbeat);
      element.removeEventListener("focusin", onFocusIn);
      element.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("blur", onWindowBlur);
      focused = false;
      sendFocus();
      generation++;
      fitRef.current = null;
      sendKeyRef.current = null;
      ctrlRef.current = false;
      setCtrl(false);
      clearTimeout(retry);
      themeObserver.disconnect();
      stream?.close();
      observer.disconnect();
      input.dispose();
      sizes.dispose();
      term.dispose();
    };
  }, [hostId, terminal.id]);

  useEffect(() => {
    if (active) requestAnimationFrame(() => fitRef.current?.());
  }, [active]);
  return (
    <div className="workspace-terminal" hidden={!active}>
      {error && (
        <div className="workspace-terminal-error" role="status">
          {error}
        </div>
      )}
      <div className="workspace-terminal-screen">
        <div
          className="workspace-terminal-viewport"
          ref={container}
          onKeyDown={(event) => event.stopPropagation()}
        />
      </div>
      <div
        className="workspace-terminal-keys"
        role="toolbar"
        aria-label="Terminal keys"
        onKeyDown={(event) => event.stopPropagation()}
      >
        {["Esc", "Tab", "Ctrl", "Ctrl-C", "Left", "Down", "Up", "Right"].map(
          (key) => (
            <button
              key={key}
              type="button"
              aria-label={key}
              aria-pressed={key === "Ctrl" ? ctrl : undefined}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                if (key === "Ctrl") {
                  ctrlRef.current = !ctrlRef.current;
                  setCtrl(ctrlRef.current);
                  container.current
                    ?.querySelector<HTMLTextAreaElement>(
                      ".xterm-helper-textarea",
                    )
                    ?.focus();
                } else sendKeyRef.current?.(key);
              }}
            >
              {(
                {
                  Left: "←",
                  Down: "↓",
                  Up: "↑",
                  Right: "→",
                  "Ctrl-C": "^C",
                } as Record<string, string>
              )[key] ?? key}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
