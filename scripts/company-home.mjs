#!/usr/bin/env node
// Prints COMPANY_HOME as hq, the shifts and the MCP resolve it (packages/shared/src/company-home.ts): env
// COMPANY_HOME, else `companyHome` in <state>/hq.config.json, else this engine checkout. For the shell scripts.
//   node scripts/company-home.mjs [stateDir]
import { resolveCompanyHome } from '../packages/shared/src/company-home.ts';

console.log(resolveCompanyHome({ stateRoot: process.argv[2] || undefined }));
