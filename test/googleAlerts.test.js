const test = require('node:test');
const assert = require('node:assert');
const { parseRssItems } = require('../lib/googleAlerts');

// Real Atom feed content the user pasted from an actual Google Alerts feed -
// confirms the parser matches what Google Alerts really sends (Atom, not
// RSS 2.0, which an earlier version of this parser was wrongly built for).
const REAL_FEED_SAMPLE = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:idx="urn:atom-extension:indexing">
<id>tag:google.com,2005:reader/user/00651117406639347610/state/com.google/alerts/11001411275176557724</id>
<title>Google Alert - memecoin launch</title>
<link href="https://www.google.com/alerts/feeds/00651117406639347610/11001411275176557724" rel="self"/>
<updated>2026-08-31T16:42:38Z</updated>
<entry>
<id>tag:google.com,2013:googlealerts/feed:17440847249129969091</id>
<title type="html">Robinhood hits all-time revenue highs as PONS holds 7% mindshare - Crypto Briefing</title>
<link href="https://www.google.com/url?rct=j&amp;sa=t&amp;url=https://cryptobriefing.com/example"/>
<published>2026-08-31T16:42:38Z</published>
<updated>2026-08-31T16:42:38Z</updated>
<content type="html">Within weeks of &lt;b&gt;launch&lt;/b&gt;, &lt;b&gt;memecoin&lt;/b&gt; activity flooded the chain.</content>
<author><name/></author>
</entry>
<entry>
<id>tag:google.com,2013:googlealerts/feed:1764252317632315096</id>
<title type="html">Analysis: <b>Meme coin</b> frenzy causes a shift in Robinhood Chain&#39;s use cases</title>
<published>2026-08-31T16:30:00Z</published>
</entry>
</feed>`;

test('parses a real Google Alerts Atom feed (not RSS 2.0)', () => {
  const items = parseRssItems(REAL_FEED_SAMPLE);
  assert.strictEqual(items.length, 2);
  assert.ok(items[0].text.includes('pons'));
  assert.ok(Number.isFinite(items[0].publishedAtMs));
});

test('strips inline HTML tags from titles (Google bolds matched terms)', () => {
  const items = parseRssItems(REAL_FEED_SAMPLE);
  const second = items[1];
  assert.ok(!second.text.includes('<b>'));
  assert.ok(second.text.includes('meme coin'));
});

test('decodes HTML entities like &#39; in titles', () => {
  const items = parseRssItems(REAL_FEED_SAMPLE);
  assert.ok(items[1].text.includes("chain's use cases"));
});

test('returns empty array for a feed with no entries', () => {
  assert.deepStrictEqual(parseRssItems('<feed></feed>'), []);
});
