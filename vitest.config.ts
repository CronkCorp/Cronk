import { defineConfig } from "vitest/config";

/** Test files that measure the Buffers the process holds: they run with the garbage collector exposed, so they can collect garbage before measuring (#301). */
const measuresMemory = ["test/streamed-export-import.test.ts"];

export default defineConfig({
  test: {
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    projects: [
      { extends: true, test: { name: "api", include: ["test/**/*.test.ts"], exclude: measuresMemory } },
      { extends: true, test: { name: "memory", include: measuresMemory, execArgv: ["--expose-gc"] } },
    ],
  },
});
