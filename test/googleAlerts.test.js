const test = require('node:test');
const assert = require('node:assert');

// parseRssItems isn't exported (module-private), so this exercises the same
// regex logic directly against a real Google Alerts RSS shape to confirm the
// parsing approach before it ever runs against a live feed.
function parseRssItems(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of itemBlocks) {
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const dateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    if (!titleMatch) continue;
    const title = titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const publishedAtMs = dateMatch ? new Date(dateMatch[1]).getTime() : Date.now();
    if (title) items.push({ text: title.toLowerCase(), publishedAtMs });
  }
  return items;
}

test('parses Google Alerts RSS items including CDATA-wrapped titles', () => {
  const xml = `<?xml version="1.0"?>
  <rss><channel>
    <item>
      <title><![CDATA[New Solana memecoin "PEPU" launches with huge volume]]></title>
      <pubDate>Mon, 31 Aug 2026 13:00:00 GMT</pubDate>
      <link>https://example.com/a</link>
    </item>
    <item>
      <title>Plain title, no CDATA</title>
      <pubDate>Mon, 31 Aug 2026 13:05:00 GMT</pubDate>
    </item>
  </channel></rss>`;
  const items = parseRssItems(xml);
  assert.strictEqual(items.length, 2);
  assert.ok(items[0].text.includes('pepu'));
  assert.ok(Number.isFinite(items[0].publishedAtMs));
});

test('returns empty array for a feed with no items', () => {
  assert.deepStrictEqual(parseRssItems('<rss><channel></channel></rss>'), []);
});
