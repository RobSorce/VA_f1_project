// Test helper: the logos (components/ui/Wordmark.jsx) in a rendered markup.
// Each one: its size, the class names of its lockup, the name of its image
// (role="img"), the attributes of each <img> inside the image, and its tagline
// (the text after the image, inside the lockup), or null.

const attrsOf = (s) => Object.fromEntries([...s.matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));

export function logosIn(html) {
  const out = [];
  const re = /<span class="(wordmark wordmark--(\w+)[^"]*)"><span class="wordmark__logo" ([^>]*)>((?:<img [^>]*\/?>)*)<\/span>(?:<span class="wordmark__tagline">([^<]*)<\/span>)?<\/span>/g;
  for (const m of html.matchAll(re)) {
    out.push({
      classes: m[1].split(/\s+/),
      size: m[2],
      image: attrsOf(m[3]),
      imgs: [...m[4].matchAll(/<img ([^>]*?)\/?>/g)].map((i) => attrsOf(i[1])),
      tagline: m[5] ?? null,
    });
  }
  return out;
}

/** The px value of `prop` in an inline style attribute ("width:102.82px;height:16.35px"). */
export function stylePx(style, prop) {
  const m = String(style).match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([\\d.]+)px`));
  return m ? Number(m[1]) : NaN;
}
