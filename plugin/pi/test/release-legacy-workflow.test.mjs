import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Exact configuration, not proof of a GitHub-hosted workflow execution.
const expectedWorkflow = [
  'name: Validate gentle-engram release',
  '',
  'on:',
  '  push:',
  '    tags:',
  '      - "pi-v*"',
  '  workflow_dispatch:',
  '',
  'jobs:',
  '  validate:',
  '    runs-on: ubuntu-latest',
  '    permissions:',
  '      contents: read',
  '    steps:',
  '      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6',
  '',
  '      - uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5',
  '        with:',
  '          node-version: "24"',
  '          registry-url: "https://registry.npmjs.org"',
  '',
  '      - name: Verify Pi release version',
  '        working-directory: plugin/pi',
  '        env:',
  '          RELEASE_REF: ${{ github.ref }}',
  '        run: node test/release-contract.mjs "$RELEASE_REF"',
  '',
  '      - name: Run Pi plugin tests',
  '        working-directory: plugin/pi',
  '        run: npm test',
  '',
].join('\n');

test('legacy Pi tags retain validation without publishing or requesting OIDC', async () => {
  const workflow = await readFile(new URL('../../../.github/workflows/publish-pi.yml', import.meta.url), 'utf8');
  assert.equal(workflow, expectedWorkflow);
});
