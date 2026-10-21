import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = (await ipcRenderer.invoke(channel, ...args)) as Result<T>;
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function on(channel: string, cb: (payload: unknown) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: unknown): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  call,
  on,
};

contextBridge.exposeInMainWorld("harness", api);

export type HarnessApi = typeof api;
