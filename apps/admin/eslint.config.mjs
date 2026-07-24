import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

// DB drivers the console must never import (D10: never direct SQL / DB access).
const BANNED_DB_IMPORTS = [
  "pg",
  "postgres",
  "mysql",
  "mysql2",
  "sqlite3",
  "better-sqlite3",
  "drizzle-orm",
  "@prisma/client",
  "prisma",
  "knex",
  "typeorm",
];

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // Golden rule: no direct DB access, and no raw fetch in views — everything goes through
      // the typed API client (`lib/api`) or the server proxy (`app/api`).
      "no-restricted-imports": ["error", { paths: BANNED_DB_IMPORTS.map((name) => ({ name, message: "The console must not access a database directly (D10)." })) }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='fetch']",
          message: "Use the typed API client (lib/api), not raw fetch.",
        },
      ],
    },
  },
  {
    // The server proxy + typed-client layer are the only places allowed to call fetch.
    files: ["app/api/**/*.ts", "lib/api/**/*.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts", "lib/api/schema.d.ts"],
  },
];

export default eslintConfig;
