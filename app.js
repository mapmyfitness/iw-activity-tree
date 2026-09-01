'use strict';

// MMF-3280 activity-type hierarchy explorer.
// All node text is written with textContent / createTextNode — never innerHTML with
// data values — so activity names cannot inject markup.

var S = {
  current: null,      // {meta, nodes}
  proposed: null,     // {meta, moves} — moves is the EFFECTIVE map (base + my edits)
  baseMoves: {},      // as committed in data/proposed.json
  edits: {},          // my local overlay, {id: {parent, why}}; parent may be null
  trees: {},          // pane -> {byId, roots, childrenOf}
  selected: null,
  movedOnly: false,
  editMode: false
};

var LS_KEY = 'mmf3280.edits.v1';

var PANES = ['current', 'proposed'];

// ---------- data ----------

function indexNodes(nodes) {
  var byId = new Map(), childrenOf = new Map(), roots = [];
  nodes.forEach(function (n) { byId.set(n.id, n); });
  nodes.forEach(function (n) {
    if (n.parent === null || n.parent === undefined || !byId.has(n.parent)) {
      roots.push(n.id);
    } else {
      if (!childrenOf.has(n.parent)) childrenOf.set(n.parent, []);
      childrenOf.get(n.parent).push(n.id);
    }
  });
  var byName = function (a, b) {
    return byId.get(a).name.localeCompare(byId.get(b).name);
  };
  roots.sort(byName);
  childrenOf.forEach(function (v) { v.sort(byName); });
  return { byId: byId, childrenOf: childrenOf, roots: roots };
}

// Apply the proposed override map to the current node list, preserving every id.
function applyMoves(nodes, moves) {
  return nodes.map(function (n) {
    var m = Object.prototype.hasOwnProperty.call(moves, String(n.id)) ? moves[String(n.id)] : null;
    if (!m) return n;
    var c = Object.assign({}, n);
    c.parent = (m.parent === null || m.parent === undefined) ? null : m.parent;
    return c;
  });
}

function subtreeCount(t, id) {
  var kids = t.childrenOf.get(id);
  if (!kids) return 0;
  var n = kids.length;
  for (var i = 0; i < kids.length; i++) n += subtreeCount(t, kids[i]);
  return n;
}

function depthOf(t) {
  var max = 0;
  function walk(id, d) {
    if (d > max) max = d;
    var kids = t.childrenOf.get(id) || [];
    for (var i = 0; i < kids.length; i++) walk(kids[i], d + 1);
  }
  t.roots.forEach(function (r) { walk(r, 1); });
  return max;
}

function ancestors(t, id) {
  var path = [], seen = new Set(), cur = id;
  while (cur !== null && cur !== undefined && t.byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    path.unshift(cur);
    var p = t.byId.get(cur).parent;
    cur = (p === null || p === undefined) ? null : p;
  }
  return path;
}

function isMoved(id) {
  if (!S.proposed) return false;
  return Object.prototype.hasOwnProperty.call(S.proposed.moves, String(id));
}

function isEdited(id) {
  return Object.prototype.hasOwnProperty.call(S.edits, String(id));
}

// ---------- edit overlay ----------

// Effective moves = the committed proposal, with my local edits layered on top.
// An edit that puts a node back on its *current* parent is not a move at all, so
// it drops out of the map entirely rather than being recorded as a no-op.
function recomputeMoves() {
  var m = {};
  Object.keys(S.baseMoves).forEach(function (k) { m[k] = S.baseMoves[k]; });
  Object.keys(S.edits).forEach(function (k) {
    var e = S.edits[k];
    var origin = S.trees.current.byId.get(Number(k)).parent;
    var same = (e.parent === null && origin === null) || e.parent === origin;
    if (same) delete m[k];
    else m[k] = { parent: e.parent, why: e.why, tier: 'Manual edit' };
  });
  S.proposed.moves = m;
}

function saveEdits() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(S.edits)); }
  catch (e) { toast('Could not save locally: ' + e.message); }
}

function loadEdits() {
  try {
    var raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    var o = JSON.parse(raw);
    // Drop anything that no longer matches the current data set.
    Object.keys(o).forEach(function (k) {
      if (!S.trees.current.byId.has(Number(k))) delete o[k];
      else if (o[k].parent !== null && !S.trees.current.byId.has(o[k].parent)) delete o[k];
    });
    return o;
  } catch (e) { return {}; }
}

// Descendants in the proposed tree — invalid as a new parent, since reparenting a
// node beneath its own descendant creates a cycle.
function descendantsOf(t, id) {
  var out = new Set(), stack = [id];
  while (stack.length) {
    var n = stack.pop();
    (t.childrenOf.get(n) || []).forEach(function (k) {
      if (!out.has(k)) { out.add(k); stack.push(k); }
    });
  }
  return out;
}

function setParent(id, parent, why) {
  if (parent === id) { toast('A type cannot be its own parent.'); return false; }
  if (parent !== null && descendantsOf(S.trees.proposed, id).has(parent)) {
    toast('That would put ' + S.trees.current.byId.get(id).name +
          ' underneath its own descendant — cycle blocked.');
    return false;
  }
  S.edits[String(id)] = { parent: parent, why: why || '' };
  saveEdits();
  rebuildProposed();
  return true;
}

function clearEdit(id) {
  delete S.edits[String(id)];
  saveEdits();
  rebuildProposed();
}

function rebuildProposed() {
  recomputeMoves();
  S.trees.proposed = indexNodes(applyMoves(S.current.nodes, S.proposed.moves));
  renderTree('proposed');
  document.getElementById('stats-proposed').textContent =
    statsLine('proposed') + ' · ' + Object.keys(S.proposed.moves).length + ' moved';
  updateChangeCount();
  applyMovedOnly();
  if (S.selected !== null) select(S.selected, false);
  renderDrawer();
}

function updateChangeCount() {
  var n = Object.keys(S.edits).length;
  var b = document.getElementById('changecount');
  b.textContent = String(n);
  b.classList.toggle('hot', n > 0);
}

function toast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(function () { t.hidden = true; }, 3600);
}

// ---------- rendering ----------

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

function renderTree(pane) {
  var t = S.trees[pane];
  var host = document.getElementById('tree-' + pane);
  host.textContent = '';
  if (!t) return;
  var frag = document.createDocumentFragment();
  t.roots.forEach(function (id) { frag.appendChild(renderNode(pane, t, id, 1)); });
  host.appendChild(frag);
}

function renderNode(pane, t, id, depth) {
  var n = t.byId.get(id);
  var kids = t.childrenOf.get(id) || [];

  var node = el('div', 'node');
  node.dataset.id = String(id);
  if (depth >= 1 && kids.length) node.classList.add('collapsed');

  var row = el('div', 'row');
  row.dataset.id = String(id);
  if (isMoved(id)) {
    row.classList.add('moved');
    var mv = S.proposed.moves[String(id)];
    var fromP = S.trees.current.byId.get(id).parent;
    row.title =
      'Re-parented\nfrom: ' + labelOf('current', fromP) +
      '\nto:   ' + labelOf('proposed', mv.parent) +
      (mv.why ? '\n\n' + mv.why : '');
  }

  // One static glyph; expanded/collapsed state is expressed purely in CSS
  // (rotation), so no code path has to keep the character in sync.
  var tw = el('span', kids.length ? 'tw' : 'tw leaf', kids.length ? '▶' : '');
  if (kids.length) {
    tw.setAttribute('role', 'button');
    tw.setAttribute('aria-label', 'Expand or collapse ' + n.name);
  }
  row.appendChild(tw);
  row.appendChild(el('span', 'nm', n.name));
  row.appendChild(el('span', 'id', '#' + n.id));
  if (kids.length) {
    row.appendChild(el('span', 'cnt', kids.length + '/' + subtreeCount(t, id)));
  }
  if (isEdited(id)) row.classList.add('edited');

  // The re-parent control lives only on the Proposed side — the Current pane is a
  // read-only record of what's in the database.
  if (pane === 'proposed') {
    var mb = el('button', 'movebtn', 'Move…');
    mb.title = 'Choose a new parent for ' + n.name;
    mb.addEventListener('click', function (ev) {
      ev.stopPropagation();
      openPicker(id);
    });
    row.appendChild(mb);
  }

  row.addEventListener('click', function (ev) {
    if (ev.target === tw && kids.length) {
      node.classList.toggle('collapsed');
      ev.stopPropagation();
      return;
    }
    // Clicking the label of a collapsed parent opens it as well as selecting it —
    // the common tree idiom, and it makes the control discoverable.
    if (kids.length && node.classList.contains('collapsed')) {
      node.classList.remove('collapsed');
    }
    select(id, true);
  });

  node.appendChild(row);

  if (kids.length) {
    var box = el('div', 'children');
    kids.forEach(function (k) { box.appendChild(renderNode(pane, t, k, depth + 1)); });
    node.appendChild(box);
  }
  return node;
}

function labelOf(pane, id) {
  if (id === null || id === undefined) return '(root)';
  var t = S.trees[pane];
  var n = t && t.byId.get(id);
  return n ? n.name + ' #' + n.id : '#' + id;
}

// ---------- selection ----------

function revealIn(pane, id) {
  var host = document.getElementById('tree-' + pane);
  var t = S.trees[pane];
  if (!t || !t.byId.has(id)) return null;
  ancestors(t, id).forEach(function (a) {
    var nd = host.querySelector('.node[data-id="' + a + '"]');
    if (nd) nd.classList.remove('collapsed');
  });
  return host.querySelector('.row[data-id="' + id + '"]');
}

function select(id, scroll) {
  S.selected = id;
  document.querySelectorAll('.row.sel').forEach(function (r) { r.classList.remove('sel'); });
  PANES.forEach(function (p) {
    var row = revealIn(p, id);
    if (row) {
      row.classList.add('sel');
      if (scroll) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  });
  showDetail(id);
  if (history.replaceState) history.replaceState(null, '', '#id=' + id);
}

function crumbInto(host, pane, id) {
  host.textContent = '';
  var t = S.trees[pane];
  if (!t || !t.byId.has(id)) {
    host.appendChild(el('span', 'absent', 'not present'));
    return;
  }
  var path = ancestors(t, id);
  path.forEach(function (a, i) {
    if (i) host.appendChild(el('span', 'sep', '›'));
    var isMe = (a === id);
    var s = el('span', 'seg' + (isMe ? ' me' : ''), t.byId.get(a).name + ' #' + a);
    if (!isMe) {
      s.style.cursor = 'pointer';
      s.addEventListener('click', function () { select(a, true); });
    }
    host.appendChild(s);
  });
}

function kidsInto(host, pane, id) {
  host.textContent = '';
  var t = S.trees[pane];
  if (!t || !t.byId.has(id)) return;
  var kids = t.childrenOf.get(id) || [];
  if (!kids.length) { host.appendChild(el('span', null, 'no children')); return; }
  host.appendChild(el('span', null, kids.length + ' direct, ' + subtreeCount(t, id) + ' total: '));
  kids.forEach(function (k) {
    var c = el('span', 'chip', t.byId.get(k).name + ' #' + k);
    c.addEventListener('click', function () { select(k, true); });
    host.appendChild(c);
  });
}

function showDetail(id) {
  var box = document.getElementById('detail');
  box.hidden = false;
  crumbInto(document.getElementById('crumb-current'), 'current', id);
  kidsInto(document.getElementById('kids-current'), 'current', id);
  if (S.proposed) {
    crumbInto(document.getElementById('crumb-proposed'), 'proposed', id);
    kidsInto(document.getElementById('kids-proposed'), 'proposed', id);
  } else {
    document.getElementById('crumb-proposed').textContent = 'proposal not published yet';
    document.getElementById('kids-proposed').textContent = '';
  }
  var n = S.trees.current.byId.get(id);
  var bits = ['id=' + n.id];
  if (n.short_name) bits.push('short=' + n.short_name);
  if (n.mets !== null && n.mets !== undefined) bits.push('mets=' + n.mets);
  if (n.for_routes) bits.push('for_routes');
  if (n.has_steps) bits.push('has_steps');
  if (n.import_only) bits.push('import_only');
  if (n.model_type_id !== null && n.model_type_id !== undefined) bits.push('model_type=' + n.model_type_id);
  if (isMoved(id)) {
    var mv = S.proposed.moves[String(id)];
    bits.push('MOVED: ' + labelOf('current', n.parent) + ' → ' + labelOf('proposed', mv.parent));
  }
  var meta = document.getElementById('detail-meta');
  meta.textContent = bits.join('  ·  ');
  if (isMoved(id) && S.proposed.moves[String(id)].why) {
    meta.appendChild(document.createElement('br'));
    meta.appendChild(document.createTextNode(S.proposed.moves[String(id)].why));
  }
}

// ---------- search ----------

function runSearch(q) {
  var box = document.getElementById('results');
  box.textContent = '';
  document.querySelectorAll('.row.hit').forEach(function (r) { r.classList.remove('hit'); });
  q = q.trim().toLowerCase();
  if (!q) { box.hidden = true; return; }

  var t = S.trees.current;
  var hits = [];
  t.byId.forEach(function (n) {
    if (n.name.toLowerCase().indexOf(q) !== -1 || String(n.id) === q || ('#' + n.id) === q) {
      hits.push(n.id);
    }
  });
  hits.sort(function (a, b) {
    var an = t.byId.get(a).name.toLowerCase(), bn = t.byId.get(b).name.toLowerCase();
    var ax = (an === q || String(a) === q) ? 0 : (an.indexOf(q) === 0 ? 1 : 2);
    var bx = (bn === q || String(b) === q) ? 0 : (bn.indexOf(q) === 0 ? 1 : 2);
    return ax !== bx ? ax - bx : an.localeCompare(bn);
  });

  box.hidden = false;
  if (!hits.length) { box.appendChild(el('div', 'none', 'No activity type matches "' + q + '"')); return; }

  hits.slice(0, 200).forEach(function (id) {
    var r = el('div', 'r');
    r.appendChild(el('span', 'nm', t.byId.get(id).name));
    r.appendChild(el('span', 'id', '#' + id));
    if (isMoved(id)) r.appendChild(el('span', 'cnt', '• moved'));
    var path = ancestors(t, id).slice(0, -1).map(function (a) { return t.byId.get(a).name; }).join(' › ');
    r.appendChild(el('span', 'path', path || '(root)'));
    r.addEventListener('click', function () { select(id, true); });
    box.appendChild(r);
  });
  if (hits.length > 200) box.appendChild(el('div', 'none', hits.length + ' matches, showing first 200'));

  hits.forEach(function (id) {
    PANES.forEach(function (p) {
      var row = document.querySelector('#tree-' + p + ' .row[data-id="' + id + '"]');
      if (row) row.classList.add('hit');
    });
  });
  if (hits.length === 1) select(hits[0], true);
}

// ---------- filters / bulk ----------

function setAllCollapsed(collapsed) {
  document.querySelectorAll('.node').forEach(function (nd) {
    var kids = nd.querySelector(':scope > .children');
    if (!kids) return;
    nd.classList.toggle('collapsed', collapsed);
  });
}

function applyMovedOnly() {
  var on = S.movedOnly && !!S.proposed;
  document.querySelectorAll('.node').forEach(function (nd) {
    if (!on) { nd.classList.remove('dim'); return; }
    var id = Number(nd.dataset.id);
    var keep = isMoved(id) || nd.querySelector('.row.moved');
    nd.classList.toggle('dim', !keep);
  });
  if (on) setAllCollapsed(false);
}

// ---------- parent picker ----------

var pickerFor = null;

function openPicker(id) {
  pickerFor = id;
  var n = S.trees.current.byId.get(id);
  var t = S.trees.proposed;
  document.getElementById('picker-title').textContent = 'Move ' + n.name + ' #' + n.id;
  var nowParent = t.byId.get(id).parent;
  document.getElementById('picker-sub').textContent =
    'Currently under ' + (nowParent === null ? 'no parent (top-level root)' : labelOf('proposed', nowParent)) +
    ' · originally ' + (n.parent === null ? 'a top-level root' : labelOf('current', n.parent));
  var why = document.getElementById('picker-why');
  why.value = isEdited(id) ? (S.edits[String(id)].why || '')
            : (isMoved(id) ? (S.proposed.moves[String(id)].why || '') : '');
  var s = document.getElementById('picker-search');
  s.value = '';
  document.getElementById('picker').hidden = false;
  renderPickerList('');
  s.focus();
}

function closePicker() {
  document.getElementById('picker').hidden = true;
  pickerFor = null;
}

function renderPickerList(q) {
  var host = document.getElementById('picker-list');
  host.textContent = '';
  if (pickerFor === null) return;
  var t = S.trees.proposed;
  var banned = descendantsOf(t, pickerFor);
  banned.add(pickerFor);
  q = q.trim().toLowerCase();

  var cands = [];
  t.byId.forEach(function (n) {
    if (banned.has(n.id)) return;
    if (q && n.name.toLowerCase().indexOf(q) === -1 && String(n.id) !== q) return;
    cands.push(n.id);
  });
  cands.sort(function (a, b) {
    var an = t.byId.get(a).name.toLowerCase(), bn = t.byId.get(b).name.toLowerCase();
    // Roots first — they're the likely targets — then alphabetical.
    var ar = t.byId.get(a).parent === null ? 0 : 1;
    var br = t.byId.get(b).parent === null ? 0 : 1;
    return ar !== br ? ar - br : an.localeCompare(bn);
  });

  if (!cands.length) {
    host.appendChild(el('div', 'none', 'No eligible parent matches that.'));
    return;
  }
  cands.slice(0, 300).forEach(function (cid) {
    var r = el('div', 'p-row');
    var c = t.byId.get(cid);
    if (c.parent === null) r.appendChild(el('span', 'tag', 'root'));
    r.appendChild(el('span', 'nm', c.name));
    r.appendChild(el('span', 'id', '#' + cid));
    var path = ancestors(t, cid).slice(0, -1).map(function (a) { return t.byId.get(a).name; }).join(' › ');
    r.appendChild(el('span', 'path', path));
    r.addEventListener('click', function () {
      if (setParent(pickerFor, cid, document.getElementById('picker-why').value)) {
        toast(S.trees.current.byId.get(pickerFor).name + ' → ' + c.name + ' #' + cid);
        closePicker();
      }
    });
    host.appendChild(r);
  });
  if (cands.length > 300) {
    host.appendChild(el('div', 'none', cands.length + ' eligible parents; showing first 300. Type to narrow.'));
  }
}

// ---------- changes drawer + export ----------

function renderDrawer() {
  var host = document.getElementById('drawer-list');
  if (!host) return;
  host.textContent = '';
  var moves = S.proposed ? S.proposed.moves : {};
  var ids = Object.keys(moves).map(Number).sort(function (a, b) {
    // My edits float to the top.
    var ae = isEdited(a) ? 0 : 1, be = isEdited(b) ? 0 : 1;
    if (ae !== be) return ae - be;
    return S.trees.current.byId.get(a).name.localeCompare(S.trees.current.byId.get(b).name);
  });

  var mine = Object.keys(S.edits).length;
  document.getElementById('drawer-sub').textContent =
    ids.length + ' total move' + (ids.length === 1 ? '' : 's') + ' · ' +
    mine + ' from your edits (stored in this browser only)';

  if (!ids.length) { host.appendChild(el('div', 'none', 'No moves.')); return; }

  ids.forEach(function (id) {
    var row = el('div', 'd-row' + (isEdited(id) ? ' mine' : ''));
    var head = el('div', 'd-head');
    if (isEdited(id)) head.appendChild(el('span', 'tag mine', 'your edit'));
    head.appendChild(el('span', 'nm', S.trees.current.byId.get(id).name));
    head.appendChild(el('span', 'id', '#' + id));
    row.appendChild(head);

    var from = S.trees.current.byId.get(id).parent;
    var to = moves[String(id)].parent;
    var line = el('div', 'd-move');
    line.appendChild(el('span', null, from === null ? '(root)' : labelOf('current', from)));
    line.appendChild(el('span', 'arrow', ' → '));
    line.appendChild(el('span', 'newparent', to === null ? '(root)' : labelOf('proposed', to)));
    row.appendChild(line);

    if (moves[String(id)].why) row.appendChild(el('div', 'd-why', moves[String(id)].why));

    var acts = el('div', 'd-acts');
    var go = el('button', null, 'Show');
    go.addEventListener('click', function () { closeDrawer(); select(id, true); });
    acts.appendChild(go);
    var ed = el('button', null, 'Change…');
    ed.addEventListener('click', function () { closeDrawer(); openPicker(id); });
    acts.appendChild(ed);
    if (isEdited(id)) {
      var un = el('button', 'danger', 'Undo my edit');
      un.addEventListener('click', function () { clearEdit(id); });
      acts.appendChild(un);
    }
    row.appendChild(acts);
    host.appendChild(row);
  });
}

function closeDrawer() { document.getElementById('drawer').hidden = true; }

// Build a file byte-identical in shape to the committed data/proposed.json.
function exportJson() {
  var moves = S.proposed.moves;
  var newpar = {};
  S.current.nodes.forEach(function (n) { newpar[n.id] = n.parent; });
  Object.keys(moves).forEach(function (k) { newpar[Number(k)] = moves[k].parent; });
  var roots = Object.keys(newpar).filter(function (k) { return newpar[k] === null; });

  var depth = 0, kids = {};
  Object.keys(newpar).forEach(function (k) {
    var p = newpar[k];
    if (p !== null) { (kids[p] = kids[p] || []).push(Number(k)); }
  });
  var stack = roots.map(function (r) { return [Number(r), 1]; });
  while (stack.length) {
    var it = stack.pop();
    if (it[1] > depth) depth = it[1];
    (kids[it[0]] || []).forEach(function (c) { stack.push([c, it[1] + 1]); });
  }

  var out = {
    meta: {
      ticket: 'MMF-3280',
      basis: 'data/current.json',
      note: 'Override map applied to current.json. Changes PARENT_ACTIVITY_TYPE_ID only — ' +
            'no ids created, renamed, or removed.',
      moves: Object.keys(moves).length,
      roots_before: S.trees.current.roots.length,
      roots_after: roots.length,
      max_depth_before: S.current.meta.max_depth || 4,
      max_depth_after: depth,
      edited_in_browser: Object.keys(S.edits).length
    },
    moves: {}
  };
  Object.keys(moves).map(Number).sort(function (a, b) { return a - b; }).forEach(function (id) {
    out.moves[String(id)] = {
      parent: moves[String(id)].parent,
      why: moves[String(id)].why || '',
      tier: moves[String(id)].tier || 'Manual edit'
    };
  });
  return JSON.stringify(out, null, 1);
}

// ---------- boot ----------

function statsLine(pane) {
  var t = S.trees[pane];
  if (!t) return '';
  return t.byId.size + ' types · ' + t.roots.length + ' roots · depth ' + depthOf(t);
}

function proposedPlaceholder() {
  var host = document.getElementById('tree-proposed');
  host.textContent = '';
  var p = el('div', 'placeholder');
  p.appendChild(document.createTextNode(
    'The proposed restructure is not published yet. This pane fills in once ' +
    'data/proposed.json lands — same URL, no download. ' +
    'Until then the left pane is the live current hierarchy.'));
  host.appendChild(p);
  document.getElementById('stats-proposed').textContent = 'pending';
}

function showBanner(text) {
  var b = document.getElementById('banner');
  b.hidden = false;
  b.textContent = text;
}

function boot() {
  document.getElementById('srcline').textContent = S.current.meta.source;

  S.trees.current = indexNodes(S.current.nodes);
  renderTree('current');
  document.getElementById('stats-current').textContent = statsLine('current');

  if (S.proposed) {
    S.baseMoves = S.proposed.moves;
    S.edits = loadEdits();
    rebuildProposed();
    if (Object.keys(S.edits).length) {
      toast('Restored ' + Object.keys(S.edits).length +
            ' unsaved edit(s) from this browser. Open Changes to review or export.');
    }
  } else {
    proposedPlaceholder();
    document.getElementById('movedonly').disabled = true;
    document.getElementById('editmode').disabled = true;
    document.getElementById('changes').disabled = true;
  }

  var ig = S.current.meta.integrity || {};
  var flags = [];
  if (ig.orphans) flags.push(ig.orphans + ' orphaned types');
  if (ig.cycles) flags.push(ig.cycles + ' parent cycles');
  if (ig.duplicate_names) flags.push(ig.duplicate_names + ' duplicate names');
  if (flags.length) {
    showBanner('Data-quality flags in the current hierarchy: ' + flags.join(', ') +
      '. Duplicate names are a likely contributor to the roll-up confusion in MMF-3280 — see ANALYSIS.md.');
  }

  var search = document.getElementById('search');
  var timer = null;
  search.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(function () { runSearch(search.value); }, 120);
  });
  document.getElementById('clear').addEventListener('click', function () {
    search.value = ''; runSearch('');
  });
  document.getElementById('expand').addEventListener('click', function () { setAllCollapsed(false); });
  document.getElementById('collapse').addEventListener('click', function () { setAllCollapsed(true); });
  document.getElementById('movedonly').addEventListener('change', function (e) {
    S.movedOnly = e.target.checked; applyMovedOnly();
  });
  document.getElementById('detail-close').addEventListener('click', function () {
    document.getElementById('detail').hidden = true;
  });

  // --- editing ---
  var em = document.getElementById('editmode');
  em.addEventListener('click', function () {
    S.editMode = !S.editMode;
    document.body.classList.toggle('editing', S.editMode);
    em.textContent = S.editMode ? 'Done editing' : 'Edit proposal';
    em.classList.toggle('on', S.editMode);
    if (S.editMode) toast('Hover any row in the Proposed pane and click "Move…" to re-parent it.');
  });

  document.getElementById('changes').addEventListener('click', function () {
    renderDrawer();
    document.getElementById('drawer').hidden = false;
  });
  document.getElementById('drawer-close').addEventListener('click', closeDrawer);
  document.getElementById('picker-close').addEventListener('click', closePicker);

  var ps = document.getElementById('picker-search');
  var ptimer = null;
  ps.addEventListener('input', function () {
    clearTimeout(ptimer);
    ptimer = setTimeout(function () { renderPickerList(ps.value); }, 100);
  });
  document.getElementById('picker-root').addEventListener('click', function () {
    if (pickerFor === null) return;
    var nm = S.trees.current.byId.get(pickerFor).name;
    if (setParent(pickerFor, null, document.getElementById('picker-why').value)) {
      toast(nm + ' is now a top-level root.');
      closePicker();
    }
  });
  document.getElementById('picker-reset').addEventListener('click', function () {
    if (pickerFor === null) return;
    var id = pickerFor, nm = S.trees.current.byId.get(id).name;
    // Back to the database's own parent: drop any local edit AND any base-proposal move.
    delete S.edits[String(id)];
    if (Object.prototype.hasOwnProperty.call(S.baseMoves, String(id))) {
      S.edits[String(id)] = { parent: S.trees.current.byId.get(id).parent, why: '' };
    }
    saveEdits();
    rebuildProposed();
    toast(nm + ' reverted to its current parent.');
    closePicker();
  });

  document.getElementById('export-download').addEventListener('click', function () {
    var blob = new Blob([exportJson()], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'proposed.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast('Downloaded proposed.json — commit it to data/proposed.json to publish.');
  });
  document.getElementById('export-copy').addEventListener('click', function () {
    var txt = exportJson();
    if (navigator.clipboard) {
      navigator.clipboard.writeText(txt).then(function () { toast('JSON copied to clipboard.'); },
        function () { toast('Clipboard blocked — use Download instead.'); });
    } else { toast('Clipboard unavailable — use Download instead.'); }
  });
  document.getElementById('edits-reset').addEventListener('click', function () {
    if (!Object.keys(S.edits).length) { toast('You have no edits to discard.'); return; }
    if (!confirm('Discard all ' + Object.keys(S.edits).length +
                 ' of your local edits and return to the committed proposal?')) return;
    S.edits = {};
    saveEdits();
    rebuildProposed();
    toast('Your edits were discarded.');
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closePicker(); closeDrawer(); }
  });

  var m = /^#id=(\d+)$/.exec(location.hash || '');
  if (m) {
    var id = Number(m[1]);
    if (S.trees.current.byId.has(id)) select(id, true);
  }
}

// ---------- loading: encrypted bundle, or plaintext for internal/local use ----------

function b64ToBytes(s) {
  var bin = atob(s), out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// The published build ships only data/bundle.enc.json. Decryption happens here, in
// the browser; the password is never sent anywhere and is not stored.
function decryptBundle(enc, password) {
  var subtle = window.crypto && window.crypto.subtle;
  if (!subtle) return Promise.reject(new Error('This browser has no WebCrypto (needs HTTPS).'));
  return subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
    .then(function (baseKey) {
      return subtle.deriveKey(
        { name: 'PBKDF2', salt: b64ToBytes(enc.kdf.salt),
          iterations: enc.kdf.iterations, hash: enc.kdf.hash },
        baseKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    })
    .then(function (key) {
      return subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(enc.iv) }, key, b64ToBytes(enc.ct));
    })
    .then(function (plain) { return JSON.parse(new TextDecoder().decode(plain)); });
}

function startWithData(current, proposed) {
  S.current = current;
  S.proposed = proposed;
  document.getElementById('lock').hidden = true;
  boot();
}

function showLock(enc) {
  var lock = document.getElementById('lock');
  var form = document.getElementById('lock-form');
  var pw = document.getElementById('lock-pw');
  var msg = document.getElementById('lock-msg');
  var btn = document.getElementById('lock-go');
  lock.hidden = false;
  pw.focus();

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (!pw.value) return;
    btn.disabled = true;
    msg.className = 'lock-msg';
    // 600k PBKDF2 iterations take a moment; say so rather than looking hung.
    msg.textContent = 'Decrypting…';
    decryptBundle(enc, pw.value).then(function (data) {
      startWithData(data.current, data.proposed);
    }).catch(function () {
      // AES-GCM authentication failure is indistinguishable from a wrong password,
      // which is exactly what we want to report.
      btn.disabled = false;
      msg.className = 'lock-msg bad';
      msg.textContent = 'That password did not work.';
      pw.select();
    });
  });
}

fetch('data/bundle.enc.json')
  .then(function (r) { return r.ok ? r.json() : null; })
  .catch(function () { return null; })
  .then(function (enc) {
    if (enc) { showLock(enc); return; }
    // No encrypted bundle: internal build, load the plaintext files directly.
    return Promise.all([
      fetch('data/current.json').then(function (r) {
        if (!r.ok) throw new Error('current.json ' + r.status);
        return r.json();
      }),
      fetch('data/proposed.json').then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
    ]).then(function (res) { startWithData(res[0], res[1]); });
  })
  .catch(function (err) {
    document.getElementById('lock').hidden = true;
    document.getElementById('tree-current').appendChild(
      el('div', 'placeholder', 'Failed to load data: ' + err.message +
        ' — if you opened this file directly, serve it instead: python3 -m http.server'));
  });
