import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const source = fs.readFileSync(path.join(process.cwd(), 'frontend/src/hooks/useKdsConnection.ts'), 'utf8');
const conflictBranch = source.match(/if \(statusCode === 409\) \{[\s\S]*?\n\s*return;/)?.[0] || '';

assert.match(conflictBranch, /await fetchOrdersRest\(\);/, 'KDS conflicts refresh REST state even with an active WebSocket');
assert.doesNotMatch(conflictBranch, /wsRef\.current === null/, 'KDS conflict refresh is not gated on WebSocket absence');
console.log('✅ KDS frontend conflict refresh regression test passed');
