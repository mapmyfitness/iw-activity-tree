# Activity-Type Hierarchy Explorer

An interactive view of the MapMyFitness activity-type tree — the current structure
alongside a proposed reorganisation — for review by stakeholders.

The page is password protected. If you weren't sent a password, you aren't meant to be
here.

## Using it

- Click a top-level family to expand it, then drill down level by level.
- Search by name (`swim`) or by ID (`20`); results show each match's ancestor path.
- Selecting a type highlights the **same ID in both panes** and shows its full ancestor
  chain and children on each side — that's the comparison.
- Orange rows are types whose parent differs between the two structures. Hover one to see
  its before and after parent.
- Deep-link to any type with `#id=<id>`.

## Editing

Click **Edit proposal**, hover a row in the Proposed pane, and click **Move…** to choose a
different parent. Edits are held in your own browser only — they are not shared with
anyone and are not saved to this site. Use **Changes → Download proposed.json** to export
them and send them on.

A type can never be made its own parent or placed beneath its own descendant, so the tree
cannot be made circular. Activity-type IDs are fixed: only the parent relationship changes.

## How the data is stored

`data/bundle.enc.json` is AES-256-GCM ciphertext. The key is derived from the password
with PBKDF2-SHA256 (600,000 iterations, random salt). Decryption happens entirely in your
browser; the password is never transmitted and is not stored.

This is a single shared password, not per-person access. It cannot be revoked from someone
who already has it without re-encrypting with a new one:

```bash
SITE_PASSWORD='new-password' node tools/encrypt.mjs
```

Then commit the regenerated `data/bundle.enc.json`.

## Local development

The page fetches its data, so opening `index.html` from the filesystem won't work. Serve it:

```bash
python3 -m http.server 8731
```
