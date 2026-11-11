// PRE-HACKATHON SPIKE — NOT PART OF THE SUBMISSION
// Compiles ../vault/RoyaltyVault.cash into src/RoyaltyVault.artifact.json for the browser (dry run).
//   npm run artifact
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileFile } from 'cashc';

const artifact = compileFile(new URL('../../vault/RoyaltyVault.cash', import.meta.url));
fs.writeFileSync(fileURLToPath(new URL('../src/RoyaltyVault.artifact.json', import.meta.url)), JSON.stringify(artifact, null, 2));
console.log(`wrote src/RoyaltyVault.artifact.json (${artifact.contractName}, cashc ${artifact.compiler.version})`);
