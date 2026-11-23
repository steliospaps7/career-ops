const items = JSON.parse(process.env.BLOCK_LIST_APIFY_ITEMS || '[]');

globalThis.fetch = async (input) => {
  const url = String(input);
  let body;
  if (url.endsWith('/runs')) body = { data: { id: 'block-list-run' } };
  else if (url.endsWith('/actor-runs/block-list-run')) body = { data: { status: 'SUCCEEDED' } };
  else if (url.endsWith('/actor-runs/block-list-run/dataset/items')) body = items;
  else return new Response('unexpected request', { status: 404 });
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
