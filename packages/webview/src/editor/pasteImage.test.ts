import { describe, expect, it } from 'vitest';
import { imageInsert } from './pasteImage.js';

describe('imageInsert', () => {
  it('puts the image on a line of its own', () => {
    expect(imageInsert('ab', 1, '/x.webp')).toBe('\n![](/x.webp)\n');
    expect(imageInsert('a\n\nb', 2, '/x.webp')).toBe('![](/x.webp)');
    expect(imageInsert('', 0, '/x.webp')).toBe('![](/x.webp)');
    expect(imageInsert('text', 4, '/x.webp')).toBe('\n![](/x.webp)');
  });
});
