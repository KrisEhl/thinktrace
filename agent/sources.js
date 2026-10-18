// Source registry and citation checks shared by the research agent and the fact-checker.

export const clip = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export class SourceRegistry {
  constructor() {
    this.list = [];
    this.byUrl = new Map();
  }

  add({ url, title, content = '', score = 0 }, foundBy) {
    const key = String(url).split('#')[0];
    let src = this.byUrl.get(key);
    if (!src) {
      src = {
        id: this.list.length + 1,
        url: key,
        title: clip(title || key, 140),
        domain: domainOf(key),
        snippet: clip(content, 600),
        text: '',
        read: false,
        score,
        foundBy,
      };
      this.list.push(src);
      this.byUrl.set(key, src);
    } else if (!src.snippet && content) {
      src.snippet = clip(content, 600);
    }
    return src;
  }

  get(id) {
    return this.list[Number(id) - 1];
  }

  // Lightweight view sent to the browser.
  public(src) {
    return { id: src.id, url: src.url, title: src.title, domain: src.domain, snippet: src.snippet, read: src.read };
  }
}

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^a-z0-9%$'". -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Does `quote` really appear in `text`? Returns 'exact', 'fuzzy' or false.
export function verifyQuote(quote, text) {
  const q = norm(quote);
  const t = norm(text);
  if (q.length < 15 || !t) return false;
  if (t.includes(q)) return 'exact';
  const qw = q.split(' ');
  const tw = t.split(' ');
  const n = qw.length;
  if (n < 4 || tw.length < n) return false;
  const need = new Map();
  for (const w of qw) need.set(w, (need.get(w) ?? 0) + 1);
  let best = 0;
  for (let i = 0; i + n <= tw.length; i++) {
    const have = new Map(need);
    let hit = 0;
    for (let j = i; j < i + n; j++) {
      const c = have.get(tw[j]);
      if (c) {
        have.set(tw[j], c - 1);
        hit++;
      }
    }
    if (hit > best) best = hit;
    if (best === n) break;
  }
  return best / n >= 0.85 ? 'fuzzy' : false;
}

// Scroll-to-text link (https://wicg.github.io/scroll-to-text-fragment/) so a click lands on the quote.
export function fragmentLink(url, quote) {
  const words = String(quote ?? '')
    .replace(/[“”"]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < 4) return url;
  const enc = (s) => encodeURIComponent(s).replace(/-/g, '%2D').replace(/,/g, '%2C');
  const fragment =
    words.length <= 10 ? enc(words.join(' ')) : `${enc(words.slice(0, 5).join(' '))},${enc(words.slice(-5).join(' '))}`;
  return `${url.split('#')[0]}#:~:text=${fragment}`;
}

export const CONFIDENCE = ['low', 'medium', 'high'];
export function lowerConfidence(c) {
  const i = CONFIDENCE.indexOf(c);
  return CONFIDENCE[Math.max(0, (i === -1 ? 1 : i) - 1)];
}
