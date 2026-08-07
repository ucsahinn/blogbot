import { createServer } from "vite";

const qaPort = Number(process.env.BLOGBOT_QA_PORT ?? "4173");

export default async function startBrowserQaServer() {
  const server = await createServer({
    root: "apps/desktop",
    configFile: "apps/desktop/vite.config.ts",
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
