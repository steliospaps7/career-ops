// Preload for scan-title-drops.test.mjs: only fixture board-list reads can run.
import { readFileSync } from 'node:fs';
const boards = JSON.parse(readFileSync(process.env.TITLE_DROPS_FIXTURE, 'utf8'));
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  const slug = url.pathname.match(/^\/v1\/boards\/([^/]+)\/jobs$/)?.[1];
  if (url.hostname !== 'boards-api.greenhouse.io' || !boards[slug]) {
    throw new Error(`Unexpected fetch during title measurement: ${url}`);
  }
  return new Response(JSON.stringify({ jobs: boards[slug] }), {
    headers: { 'content-type': 'application/json' },
  });
};
