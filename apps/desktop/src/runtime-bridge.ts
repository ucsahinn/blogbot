import {
  BridgeError,
  createInvokeBridge,
  type BlogbotBridge,
  type InvokeTransport
} from "./bridge.ts";
import { createDemoTransport } from "./demo-data.ts";

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

  if (import.meta.env.DEV) {
    return createInvokeBridge(createDemoTransport());
  }

  throw new BridgeError(
    "BRIDGE_UNAVAILABLE",
    "Blogbot yalnızca imzalı masaüstü uygulaması içinde çalışır."
  );
}
