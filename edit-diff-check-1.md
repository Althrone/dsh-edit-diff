# Edit Diff — Check 1

A fresh Markdown file, created after the 0.13.3 upgrade.

## What to look for

| Signal | Meaning |
|---|---|
| Sidebar opens | `openTab` reached the repo |
| One **Edit Diff** tab | no native preview per file (`dsh-edit-diff:native = 0`) |
| Right column tinted | additions came from the wire view |

Inline `code`, a [link](https://example.com), and a fence:

```js
const pad = (n) => String(n).padStart(2, "0");
console.log(`ready ${pad(7)}:30`);
```

## Appended later (revised)

- Additions should be green on the right side only

```text
appended block #1
appended block #2
```

First edit of the pair: a note that lands in the middle of the file.

Second edit of the pair:

1. The tab should refresh in place, not open a second one.
2. Focus should already be on the diff tab, so no new focus grab.

## Third pass: add content

- heading renamed in pass 1 (modification)
- one bullet removed in pass 2 (deletion)
- this section appended in pass 3 (addition)
