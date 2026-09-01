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

Click **Edit proposal**, then hover any row in the Proposed pane. Three controls appear:

| Control | What it proposes |
|---|---|
| **Move…** | A different parent. Choose from a searchable list, make it top-level, or revert it to its database parent. |
| **Rename…** | A different display name. The activity-type ID never changes. |
| **+ Child** | A brand-new category underneath that type. **+ New top-level** in the header adds one at the root. |

Every change is flagged in the Proposed pane and in the footer legend:

- **orange** — re-parented
- **purple + `RENAMED`** — renamed, with the database name shown struck through beside it
- **green + `NEW`** — a category that does not exist in the database

New categories carry a **placeholder ID** (shown as `NEW`, never a number) because real
`activity_type_id`s are assigned by the database. The export marks each one
`"placeholder id — assign a real ACTIVITY_TYPE_ID at implementation"`.

Edits are held in your own browser only — not shared, not saved to this site. Use
**Changes → Download proposed.json** to export and send them on. The Changes drawer groups
everything into New categories / Renamed / Re-parented, with per-item undo.

**Guards.** A type can't be its own parent or sit beneath its own descendant, so the tree
can't be made circular. Names can't be empty. A new category can't be removed while it
still has children. Existing activity-type IDs are never created, renumbered, or deleted —
only `parent` and, where you ask for it, the display name.

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
