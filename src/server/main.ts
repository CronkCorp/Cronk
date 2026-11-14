import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { systemClock } from "./clock.js";
import { loadConfig } from "./config.js";

// The built client lives in dist/web, next to dist/server where this file is compiled to.
const builtWebRoot = fileURLToPath(new URL("../../dist/web", import.meta.url));

const config = loadConfig(process.env, existsSync(builtWebRoot) ? builtWebRoot : undefined);
const app = await buildApp({ config, clock: systemClock, logger: true });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: config.host, port: config.port });
