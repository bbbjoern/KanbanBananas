import { describe, expect, it } from 'vitest';
import { imageFileName, imageLink, imageRefs } from '../src/index.js';

describe('images', () => {
  it('names files by time', () => {
    expect(imageFileName(new Date(2026, 8, 29, 14, 30, 12), 'webp')).toBe('2026-09-29-143012.webp');
  });

  it('links from the project root', () => {
    expect(imageLink('.devtool/assets/a/x.webp')).toBe('/.devtool/assets/a/x.webp');
  });

  it('finds root-relative image references, markdown and HTML, and nothing else', () => {
    const body = [
      '# T',
      '![shot](/.devtool/assets/a/1.webp)',
      '![](/.devtool/assets/a/2%20b.png "title")',
      '<img src="/.devtool/assets/b/3.png" width="200">',
      '![web](https://example.com/x.png)',
      '![rel](images/y.png)',
      '[not an image](/.devtool/assets/a/4.png)',
    ].join('\n');
    expect(imageRefs(body)).toEqual(['.devtool/assets/a/1.webp', '.devtool/assets/a/2 b.png', '.devtool/assets/b/3.png']);
  });
});
