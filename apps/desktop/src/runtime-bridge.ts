import {
  BridgeError,
  createInvokeBridge,
  type BlogbotBridge,
  type InvokeTransport
} from "./bridge.ts";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export async function createRuntimeBridge(): Promise<BlogbotBridge> {
  if (typeof window !== "undefined" && window.__TAURI_INTERNALS__) {
    const { invoke } = await import("@tauri-apps/api/core");
    const transport: InvokeTransport = (command, args) => invoke(command, args);
    return createInvokeBridge(transport);
  }

  throw new BridgeError(
    "BRIDGE_UNAVAILABLE",
    "Blogbot yalnızca Windows masaüstü uygulaması içinde çalışır. Yerel geliştirme için Tauri çalışma zamanını başlatın."
  );
}
