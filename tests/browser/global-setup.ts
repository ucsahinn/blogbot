import { createServer } from "vite";
import { resolve } from "node:path";

const qaPort = Number(process.env.BLOGBOT_QA_PORT ?? "4173");

export default async function startBrowserQaServer() {
  const server = await createServer({
    root: "apps/desktop",
    // Vite resolves a relative configFile from the configured root. Supplying
    // an absolute path keeps browser QA runnable from the repository root.
    configFile: resolve("apps/desktop/vite.config.ts"),
    server: {
      host: "127.0.0.1",
      port: qaPort,
      strictPort: true
    }
  });

  await server.listen();

  return async () => {
    await server.close();
  };
}
