const fs = require('fs');

const html = fs.readFileSync('dist-playable/facebook.html', 'utf8');
const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;

let m;
let idx = 0;
let bad = 0;

while ((m = re.exec(html))) {
  idx += 1;
  const attrs = m[1] || '';
  const body = m[2] || '';
  const typeMatch = /type\s*=\s*['\"]([^'\"]+)['\"]/i.exec(attrs);
  const type = typeMatch ? typeMatch[1] : 'text/javascript';

  if (type === 'systemjs-importmap' || type === 'application/octet-stream') continue;
  if (!body.trim()) continue;

  try {
    // Compile-only check for syntax validity.
    // eslint-disable-next-line no-new-func
    new Function(body);
  } catch (e) {
    bad += 1;
    const snippet = body.slice(0, 200).replace(/\n/g, '\\n');
    console.log(`[BAD] #${idx} type=${type} err=${e.message}`);
    console.log(`[SNIP] ${snippet}`);
  }
}

console.log(`totalScripts=${idx} bad=${bad}`);
