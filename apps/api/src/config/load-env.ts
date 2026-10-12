import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

// Both source files and compiled files are four levels below the repository root.
config({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)) });
