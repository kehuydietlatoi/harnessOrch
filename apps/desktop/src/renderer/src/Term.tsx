import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const THEME = { background: "#0b0d11", foreground: "#d6dae1", cursor: "#9aa4b2", selectionBackground: "#2b3442" };

export interface TermHandle { write(data: string): void; term: Terminal }

/**
 * One xterm instance. Stays mounted while hidden so its scrollback survives tab
 * switches. `onInput` makes it interactive (PTY); omit it for read-only streams.
 */
export function Term(props: {
  visible: boolean;
  onReady: (h: TermHandle) => void;
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const fit = useRef<FitAddon | null>(null);
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    const term = new Terminal({ fontFamily: "Cascadia Mono, Consolas, monospace", fontSize: 12.5, theme: THEME,
      convertEol: false, scrollback: 5000, disableStdin: !props.onInput, cursorBlink: !!props.onInput });
    const f = new FitAddon();
    term.loadAddon(f);
    term.open(host.current!);
    fit.current = f;
    const input = term.onData((d) => cb.current.onInput?.(d));
    const resized = term.onResize(({ cols, rows }) => cb.current.onResize?.(cols, rows));
    const ro = new ResizeObserver(() => { if (host.current?.offsetParent) f.fit(); });
    ro.observe(host.current!);
    cb.current.onReady({ write: (d) => term.write(d), term });
    return () => { ro.disconnect(); input.dispose(); resized.dispose(); term.dispose(); };
  }, []);

  useEffect(() => { if (props.visible) requestAnimationFrame(() => fit.current?.fit()); }, [props.visible]);

  return <div ref={host} className="term" style={{ display: props.visible ? "block" : "none" }} />;
}
