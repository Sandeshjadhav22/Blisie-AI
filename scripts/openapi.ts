import { writeFileSync } from 'node:fs';

import { buildOpenApiSpec } from '../src/openapi/spec.js';

/** Writes openapi.json. The frontend turns it into types with `pnpm api:types`. */
writeFileSync(
  new URL('../openapi.json', import.meta.url),
  `${JSON.stringify(buildOpenApiSpec(), null, 2)}\n`,
);
process.stdout.write('Wrote openapi.json\n');
