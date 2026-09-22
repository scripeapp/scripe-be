/** @type {import('jest').Config} */
const transformTs = [
  "ts-jest",
  {
    diagnostics: false,
    tsconfig: {
      module: "CommonJS",
      moduleResolution: "Node",
      target: "ES2022",
      esModuleInterop: true,
      allowJs: true,
      verbatimModuleSyntax: false,
    },
  },
];

export default {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.ts"],
  setupFiles: ["<rootDir>/jest.setup.ts"],
  moduleNameMapper: {
    "^@/(.*)\\.js$": "<rootDir>/src/$1.ts",
    "^@/([^.]*)$": "<rootDir>/src/$1",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.(ts|mts|cts)$": transformTs,
    "^.+\\.(mjs|js)$": transformTs,
  },
  transformIgnorePatterns: [
    "/node_modules/(?!(?:better-auth|@better-auth|better-call|@better-fetch|@noble|jose|nanostores|defu|zod|rou3|kysely|@simplewebauthn|@hexagon|asn1js|pvtsutils|pvutils|tslib|@levischuck)/)",
  ],
  clearMocks: true,
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/db/migrate.ts",
    "!src/db/migrate-cli.ts",
    "!src/db/seed.ts",
    "!src/db/check.ts",
    "!src/db/generate-types.ts",
    "!src/server.ts",
    "!src/db/database.types.codegen.ts",
  ],
};
