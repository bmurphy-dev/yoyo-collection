// Loads a `.env` file sitting next to this one, if there is a one.
//
// Docker Compose passes configuration into the container directly (see
// `env_file:` / `environment:` in docker-compose.yml), so a .env file is
// already honored there. This covers the `npm start` / `node server.js` path,
// which otherwise ignores .env completely — there's no dotenv dependency —
// and silently runs with defaults, even though README and .env.example both
// tell you to create one.
//
// Import this FIRST, before any module that reads process.env while loading:
// db.js resolves DB_PATH (and creates that directory) the moment it's imported.
// ESM evaluates imports in source order, so its position in server.js's import
// list is what makes the ordering work.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');

try {
  process.loadEnvFile(envPath);
} catch {
  // No .env file — the normal case in Docker and for a default install.
  // Configuration comes from the real environment instead.
}
