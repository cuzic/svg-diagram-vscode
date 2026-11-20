// The manifest is the extension's public surface: every contributed command must be registered in the code, and vice versa.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';

const root = new URL('../../', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
const source = fs.readFileSync(new URL('src/extension.ts', root), 'utf8');

test('contributed commands are registered in src/extension.ts', () => {
  const contributed: string[] = manifest.contributes.commands.map((c: {command: string}) => c.command);
  const registered = [...source.matchAll(/registerCommand\('([^']+)'/g)].map(m => m[1]);
  assert.deepEqual([...registered].sort(), [...contributed].sort());
});

test('every command is in the svg-diagram category and has a title', () => {
  for (const c of manifest.contributes.commands) {
    assert.equal(c.category, 'svg-diagram', c.command);
    assert.ok(c.title, c.command);
  }
});

test('jsonValidation names only schemas the extension serves, and the scheme activates the extension', async () => {
  const {SCHEMA_FILES, schemaUri, SCHEMA_SCHEME} = await import('../../src/schemas.ts');
  const served = new Set(SCHEMA_FILES.map(schemaUri));
  for (const v of manifest.contributes.jsonValidation) assert.ok(served.has(v.url), v.url);
  assert.ok(manifest.activationEvents.includes(`onFileSystem:${SCHEMA_SCHEME}`));
  assert.ok(manifest.contributes.configuration.properties['svgDiagram.jsonSchemas.enabled']);
});
