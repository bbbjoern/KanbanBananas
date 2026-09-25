# Corpus snapshot

Copy the real board's features directory here to run the M0 corpus tests:

```sh
cp -R /path/to/project/.devtool/features packages/core/test/corpus/features
```

`features/` is git-ignored. `corpus.test.ts` skips itself when it's missing.
