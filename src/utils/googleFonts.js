// Extracts font entries from a pasted Google Fonts <link> snippet (or a bare
// URL/query string). Google Fonts CSS2 links are cumulative - a snippet may
// contain several "family=" params - so this returns every distinct one
// found, letting callers add just the new fonts and skip ones already saved.
function parseFontsFromSnippet(snippet) {
  const matches = [...String(snippet || '').matchAll(/family=([^&"'\s]+)/g)].map((m) =>
    decodeURIComponent(m[1])
  );

  const seen = new Set();
  const fonts = [];
  for (const family_param of matches) {
    const name = family_param.split(':')[0].replace(/\+/g, ' ').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    fonts.push({ name, family_param });
  }
  return fonts;
}

module.exports = { parseFontsFromSnippet };
