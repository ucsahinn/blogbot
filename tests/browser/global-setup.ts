import { createServer } from "vite";
import { resolve } from "node:path";

const qaPort = Number(process.env.BLOGBOT_QA_PORT ?? "4173");
const viteHmrClientScript = /\s*<script type="module" src="\/@vite\/client"><\/script>/u;

const browserQaWithoutHmr = {
  name: "blogbot-browser-qa-without-hmr",
  transformIndexHtml: {
    order: "post" as const,
    handler(html: string) {
      return html.replace(viteHmrClientScript, "");
    }
  }
};

export default async function startBrowserQaServer() {
  const server = await createServer({
    root: "apps/desktop",
    // Vite resolves a relative configFile from the configured root. Supplying
    // an absolute path keeps browser QA runnable from the repository root.
    configFile: resolve("apps/desktop/vite.config.ts"),
    plugins: [browserQaWithoutHmr],
    server: {
      host: "127.0.0.1",
      port: qaPort,
      strictPort: true,
      hmr: false
    }
  });

  await server.listen();

  const qaDocument = await fetch(`http://127.0.0.1:${qaPort}/qa.html`).then(
    (response) => response.text()
  );
  if (qaDocument.includes("/@vite/client")) {
    await server.close();
    throw new Error("Browser QA must not load the Vite HMR client.");
  }

  return async () => {
    await server.close();
  };
}
