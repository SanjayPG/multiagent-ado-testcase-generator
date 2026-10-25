import { buildApp } from "./app.js";
import { config, getEnvStatus } from "./config.js";
import { shutdown } from "./runner.js";

const main = async (): Promise<void> => {
  const app = await buildApp();
  await app.listen({ host: config.host, port: config.port });
  const env = getEnvStatus();
  console.log(`tc-generator UI: http://${config.host}:${config.port}`);
  console.log(`  repo root: ${config.repoRoot}`);
  console.log(`  ADO_PAT_B64 ${env.pat ? "set" : "MISSING"} · ADO_ORG ${env.org ? "set" : "MISSING"} · ADO_PROJECT ${env.project ? "set" : "MISSING"}`);

  const stop = async (): Promise<void> => {
    shutdown();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
