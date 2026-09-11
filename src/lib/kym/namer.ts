/**
 * Assemble a committee name out of the words one operator actually uses.
 *
 * Plain module rather than part of the client component, because both sides
 * need it: the server makes the first name so that the markup it sends is the
 * markup the browser hydrates, and the button makes every one after that.
 *
 * The joke only works because nothing here is invented. Every word comes from
 * committees currently on file under one chair and treasurer, and the
 * weighting is how often he uses it — so "Florida" turns up in a third of the
 * results for the same reason it turns up in 55 of his 229 committees.
 */

import type { VocabularyWord } from '@/lib/graph/officers';

/**
 * How a name is put together.
 *
 * Mostly a plain run of words, which is what his names are. The two framings
 * are his as well: 22 of the 229 are "Friends of" somebody, and "Floridians
 * for" is a family of its own.
 */
type Shape = 'plain' | 'friends' | 'floridians';

const SHAPES: { shape: Shape; weight: number }[] = [
  { shape: 'plain', weight: 7 },
  { shape: 'friends', weight: 2 },
  { shape: 'floridians', weight: 1 },
];

/** Pick one word, with a common word likelier than a rare one. */
function weighted(pool: VocabularyWord[]): VocabularyWord {
  const total = pool.reduce((a, w) => a + w.committees, 0);
  let n = Math.random() * total;
  for (const w of pool) {
    n -= w.committees;
    if (n <= 0) return w;
  }
  return pool[pool.length - 1];
}

function pickShape(): Shape {
  const total = SHAPES.reduce((a, s) => a + s.weight, 0);
  let n = Math.random() * total;
  for (const s of SHAPES) {
    n -= s.weight;
    if (n <= 0) return s.shape;
  }
  return 'plain';
}

/**
 * Two to four words, never the same one twice.
 *
 * Drawing without replacement matters more than it sounds. Weighted picks land
 * on "Florida" often enough that names would otherwise come out as "Florida
 * Florida Fund" regularly, which is a different and worse joke.
 */
export function invent(pool: VocabularyWord[]): string {
  if (pool.length < 2) return '';
  const shape = pickShape();
  const want = shape === 'plain' ? 2 + Math.floor(Math.random() * 3) : 2;

  const taken: string[] = [];
  let guard = 0;
  while (taken.length < Math.min(want, pool.length) && guard < 50) {
    guard += 1;
    const word = weighted(pool).word;
    if (!taken.includes(word)) taken.push(word);
  }

  if (shape === 'friends') return `Friends of ${taken.join(' ')}`;
  if (shape === 'floridians') return `Floridians for ${taken.join(' ')}`;
  return taken.join(' ');
}
