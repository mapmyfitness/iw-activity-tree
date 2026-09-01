'use strict';

// MMF-3280 activity-type hierarchy explorer.
// All node text is written with textContent / createTextNode — never innerHTML with
// data values — so activity names cannot inject markup.

var S = {
  current: null,      // {meta, nodes}
  proposed: null,     // {meta, moves, renames, additions} — all EFFECTIVE (base + my edits)
  baseMoves: {}, baseRenames: {}, baseAdditions: {},   // as committed in data/proposed.json
  edits: {},          // my local move overlay,   {id: {parent, why}}
  renames: {},        // my local rename overlay, {id: {name, why}}
  additions: {},      // my local new types,      {tmpId: {name, parent, why}}
  trees: {},          // pane -> {byId, roots, childrenOf}
  selected: null,
  movedOnly: false,
  editMode: false
};

var LS_KEY = 'mmf3280.edits.v2';

// New activity types have no real activity_type_id — the database assigns those. They
// get negative placeholder ids so they can never collide with a real one, and every
// surface (badges, export, drawer) labels them as needing an id on implementation.
function isNew(id) { return typeof id === 'number' && id < 0; }
function nextTmpId() {
  var min = 0;
  Object.keys(S.additions).forEach(function (k) { min = Math.min(min, Number(k)); });
  Object.keys(S.baseAdditions).forEach(function (k) { min = Math.min(min, Number(k)); });
  return min - 1;
}

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

// Build the proposed node list: every real type with its proposed parent and proposed
// name, plus any newly added types. Real ids are never altered.
function buildProposedNodes() {
  var moves = S.proposed.moves, renames = S.proposed.renames;
  var out = S.current.nodes.map(function (n) {
    var m = moves[String(n.id)], r = renames[String(n.id)];
    if (!m && !r) return n;
    var c = Object.assign({}, n);
    if (m) c.parent = (m.parent === null || m.parent === undefined) ? null : m.parent;
    if (r) { c.was = n.name; c.name = r.name; }
    return c;
  });
  Object.keys(S.proposed.additions).forEach(function (k) {
    var a = S.proposed.additions[k];
    out.push({ id: Number(k), name: a.name, parent: a.parent, isNew: true,
               short_name: null, for_routes: null, model_type_id: null,
               mets: null, has_steps: null, import_only: null });
  });
  return out;
}

// Tolerate proposal files written before renames/additions existed.
function isRenamed(id) {
  return !!(S.proposed && S.proposed.renames &&
            Object.prototype.hasOwnProperty.call(S.proposed.renames, String(id)));
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
  return !!(S.proposed && S.proposed.moves &&
            Object.prototype.hasOwnProperty.call(S.proposed.moves, String(id)));
}

function isEdited(id) {
  return Object.prototype.hasOwnProperty.call(S.edits, String(id)) ||
         Object.prototype.hasOwnProperty.call(S.renames, String(id)) ||
         Object.prototype.hasOwnProperty.call(S.additions, String(id));
}

// A real type's name as recorded in the database, for before/after display.
function originalName(id) {
  var n = S.trees.current.byId.get(id);
  return n ? n.name : null;
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

  // Renames: setting a name back to the database name is not a rename, so it drops out.
  var r = {};
  Object.keys(S.baseRenames).forEach(function (k) { r[k] = S.baseRenames[k]; });
  Object.keys(S.renames).forEach(function (k) {
    var e = S.renames[k];
    if (!e.name || e.name === originalName(Number(k))) delete r[k];
    else r[k] = { name: e.name, why: e.why };
  });
  S.proposed.renames = r;

  var a = {};
  Object.keys(S.baseAdditions).forEach(function (k) { a[k] = S.baseAdditions[k]; });
  Object.keys(S.additions).forEach(function (k) { a[k] = S.additions[k]; });
  S.proposed.additions = a;
}

function saveEdits() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(
      { edits: S.edits, renames: S.renames, additions: S.additions }));
  } catch (e) { toast('Could not save locally: ' + e.message); }
}

function knownId(id) {
  return S.trees.current.byId.has(id) ||
         Object.prototype.hasOwnProperty.call(S.additions, String(id)) ||
         Object.prototype.hasOwnProperty.call(S.baseAdditions, String(id));
}

function loadEdits() {
  var empty = { edits: {}, renames: {}, additions: {} };
  try {
    var raw = localStorage.getItem(LS_KEY);
    if (!raw) return empty;
    var o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return empty;
    var st = { edits: o.edits || {}, renames: o.renames || {}, additions: o.additions || {} };
    // Additions load first so moves/renames can legitimately reference them.
    S.additions = st.additions;
    Object.keys(st.edits).forEach(function (k) {
      if (!knownId(Number(k))) delete st.edits[k];
      else if (st.edits[k].parent !== null && !knownId(st.edits[k].parent)) delete st.edits[k];
    });
    Object.keys(st.renames).forEach(function (k) {
      if (!S.trees.current.byId.has(Number(k))) delete st.renames[k];
    });
    Object.keys(st.additions).forEach(function (k) {
      var p = st.additions[k].parent;
      if (p !== null && !knownId(p)) st.additions[k].parent = null;
    });
    return st;
  } catch (e) { return empty; }
}

function setName(id, name, why) {
  name = (name || '').trim();
  if (!name) { toast('A name cannot be empty.'); return false; }
  if (name.length > 120) { toast('That name is too long (120 characters max).'); return false; }
  if (isNew(id)) {
    S.additions[String(id)].name = name;
    if (why !== undefined) S.additions[String(id)].why = why;
  } else {
    S.renames[String(id)] = { name: name, why: why || '' };
  }
  saveEdits();
  rebuildProposed();
  return true;
}

function clearRename(id) {
  delete S.renames[String(id)];
  saveEdits();
  rebuildProposed();
}

function addChild(parentId, name, why) {
  name = (name || '').trim();
  if (!name) { toast('A name cannot be empty.'); return null; }
  var id = nextTmpId();
  S.additions[String(id)] = { name: name, parent: parentId, why: why || '' };
  saveEdits();
  rebuildProposed();
  return id;
}

function removeAddition(id) {
  var kids = S.trees.proposed.childrenOf.get(id) || [];
  if (kids.length) {
    toast('Move its ' + kids.length + ' child type(s) elsewhere before removing this category.');
    return false;
  }
  delete S.additions[String(id)];
  // Any move or rename that pointed at it is now meaningless.
  Object.keys(S.edits).forEach(function (k) {
    if (S.edits[k].parent === id) delete S.edits[k];
  });
  saveEdits();
  if (S.selected === id) S.selected = null;
  rebuildProposed();
  return true;
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
    toast('That would put ' + anyName(id) + ' underneath its own descendant — cycle blocked.');
    return false;
  }
  if (isNew(id)) {
    // A new category has no database parent to diff against; store it inline.
    S.additions[String(id)].parent = parent;
    if (why) S.additions[String(id)].why = why;
  } else {
    S.edits[String(id)] = { parent: parent, why: why || '' };
  }
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
  S.trees.proposed = indexNodes(buildProposedNodes());
  renderTree('proposed');
  var p = S.proposed;
  document.getElementById('stats-proposed').textContent =
    statsLine('proposed') + ' · ' + Object.keys(p.moves).length + ' moved · ' +
    Object.keys(p.renames).length + ' renamed · ' + Object.keys(p.additions).length + ' new';
  updateChangeCount();
  applyMovedOnly();
  if (S.selected !== null && S.trees.proposed.byId.has(S.selected)) select(S.selected, false);
  renderDrawer();
}

function updateChangeCount() {
  var n = Object.keys(S.edits).length + Object.keys(S.renames).length +
          Object.keys(S.additions).length;
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
  var tips = [];
  if (isNew(id)) {
    row.classList.add('isnew');
    var ad = S.proposed.additions[String(id)];
    tips.push('NEW category — needs a real activity_type_id when implemented.' +
              (ad && ad.why ? '\n' + ad.why : ''));
  } else {
    if (isMoved(id)) {
      row.classList.add('moved');
      var mv = S.proposed.moves[String(id)];
      var fromP = S.trees.current.byId.get(id).parent;
      tips.push('Re-parented\nfrom: ' + labelOf('current', fromP) +
                '\nto:   ' + labelOf('proposed', mv.parent) +
                (mv.why ? '\n' + mv.why : ''));
    }
    if (isRenamed(id)) {
      row.classList.add('renamed');
      var rn = S.proposed.renames[String(id)];
      tips.push('Renamed\nfrom: ' + originalName(id) + '\nto:   ' + rn.name +
                (rn.why ? '\n' + rn.why : ''));
    }
  }
  if (tips.length) row.title = tips.join('\n\n');

  // One static glyph; expanded/collapsed state is expressed purely in CSS
  // (rotation), so no code path has to keep the character in sync.
  var tw = el('span', kids.length ? 'tw' : 'tw leaf', kids.length ? '▶' : '');
  if (kids.length) {
    tw.setAttribute('role', 'button');
    tw.setAttribute('aria-label', 'Expand or collapse ' + n.name);
  }
  row.appendChild(tw);
  row.appendChild(el('span', 'nm', n.name));

  // Additions have no activity_type_id yet; show that rather than a fake number.
  if (isNew(id)) row.appendChild(el('span', 'flag new', 'NEW'));
  else row.appendChild(el('span', 'id', '#' + n.id));

  if (pane === 'proposed' && isRenamed(id)) {
    row.appendChild(el('span', 'flag ren', 'RENAMED'));
    row.appendChild(el('span', 'was', originalName(id)));
  }
  if (kids.length) {
    row.appendChild(el('span', 'cnt', kids.length + '/' + subtreeCount(t, id)));
  }
  if (isEdited(id)) row.classList.add('edited');

  // Editing controls live only on the Proposed side — the Current pane is a
  // read-only record of what's in the database.
  if (pane === 'proposed') {
    var acts = el('span', 'rowacts');
    [['Move…', function () { openPicker(id); }],
     ['Rename…', function () { openRename(id); }],
     ['+ Child', function () { openAdd(id); }]
    ].forEach(function (spec) {
      var b = el('button', 'movebtn', spec[0]);
      b.addEventListener('click', function (ev) { ev.stopPropagation(); spec[1](); });
      acts.appendChild(b);
    });
    if (isNew(id)) {
      var rm = el('button', 'movebtn danger', 'Remove');
      rm.title = 'Remove this proposed category';
      rm.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (removeAddition(id)) toast('Removed proposed category "' + n.name + '".');
      });
      acts.appendChild(rm);
    }
    row.appendChild(acts);
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
  if (!n) return isNew(id) ? '(new category)' : '#' + id;
  return n.name + (isNew(id) ? ' (new)' : ' #' + n.id);
}

// Name from whichever tree knows this id — new categories exist only in the proposal.
function anyName(id) {
  var n = (S.trees.proposed && S.trees.proposed.byId.get(id)) ||
          (S.trees.current && S.trees.current.byId.get(id));
  return n ? n.name : '#' + id;
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
    var s = el('span', 'seg' + (isMe ? ' me' : ''),
               t.byId.get(a).name + (isNew(a) ? ' (new)' : ' #' + a));
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
    var c = el('span', 'chip' + (isNew(k) ? ' newchip' : ''),
               t.byId.get(k).name + (isNew(k) ? ' (new)' : ' #' + k));
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
  var n = S.trees.current.byId.get(id) || S.trees.proposed.byId.get(id);
  var bits = [isNew(id) ? 'NEW — no activity_type_id yet' : 'id=' + n.id];
  if (isRenamed(id)) bits.push('renamed: "' + originalName(id) + '" → "' +
                               S.proposed.renames[String(id)].name + '"');
  if (n.short_name) bits.push('short=' + n.short_name);
  if (n.mets !== null && n.mets !== undefined) bits.push('mets=' + n.mets);
  if (n.for_routes) bits.push('for_routes');
  if (n.has_steps) bits.push('has_steps');
  if (n.import_only) bits.push('import_only');
  if (n.model_type_id !== null && n.model_type_id !== undefined) bits.push('model_type=' + n.model_type_id);
  if (isMoved(id)) {
    var mv = S.proposed.moves[String(id)];
    bits.push('MOVED: ' + labelOf('current', S.trees.current.byId.get(id).parent) +
              ' → ' + labelOf('proposed', mv.parent));
  }
  var meta = document.getElementById('detail-meta');
  meta.textContent = bits.join('  ·  ');
  [isMoved(id) && S.proposed.moves[String(id)].why,
   isRenamed(id) && S.proposed.renames[String(id)].why,
   isNew(id) && S.proposed.additions[String(id)].why].forEach(function (w) {
    if (!w) return;
    meta.appendChild(document.createElement('br'));
    meta.appendChild(document.createTextNode(w));
  });
  if (isNew(id)) {
    meta.appendChild(document.createElement('br'));
    var warn = el('span', 'warntext',
      'This category does not exist in the database. It needs a real activity_type_id assigned at implementation.');
    meta.appendChild(warn);
  }
}

// ---------- search ----------

function runSearch(q) {
  var box = document.getElementById('results');
  box.textContent = '';
  document.querySelectorAll('.row.hit').forEach(function (r) { r.classList.remove('hit'); });
  q = q.trim().toLowerCase();
  if (!q) { box.hidden = true; return; }

  // Search both structures, so a renamed type is findable by either name and new
  // categories are findable at all.
  var t = S.trees.current, pt = S.trees.proposed;
  var seen = {}, hits = [];
  function consider(n) {
    if (seen[n.id]) return;
    if (n.name.toLowerCase().indexOf(q) !== -1 || String(n.id) === q || ('#' + n.id) === q) {
      seen[n.id] = 1; hits.push(n.id);
    }
  }
  t.byId.forEach(consider);
  if (pt) pt.byId.forEach(consider);
  hits.sort(function (a, b) {
    var an = anyName(a).toLowerCase(), bn = anyName(b).toLowerCase();
    var ax = (an === q || String(a) === q) ? 0 : (an.indexOf(q) === 0 ? 1 : 2);
    var bx = (bn === q || String(b) === q) ? 0 : (bn.indexOf(q) === 0 ? 1 : 2);
    return ax !== bx ? ax - bx : an.localeCompare(bn);
  });

  box.hidden = false;
  if (!hits.length) { box.appendChild(el('div', 'none', 'No activity type matches "' + q + '"')); return; }

  hits.slice(0, 200).forEach(function (id) {
    var r = el('div', 'r');
    r.appendChild(el('span', 'nm', anyName(id)));
    if (isNew(id)) r.appendChild(el('span', 'flag new', 'NEW'));
    else r.appendChild(el('span', 'id', '#' + id));
    if (isRenamed(id)) r.appendChild(el('span', 'flag ren', 'RENAMED'));
    if (isMoved(id)) r.appendChild(el('span', 'cnt', 'moved'));
    var src = S.trees.current.byId.has(id) ? t : pt;
    var path = ancestors(src, id).slice(0, -1)
      .map(function (a) { return anyName(a); }).join(' › ');
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
  var t = S.trees.proposed;
  var cn = S.trees.current.byId.get(id);
  document.getElementById('picker-title').textContent =
    'Move ' + anyName(id) + (isNew(id) ? ' (new)' : ' #' + id);
  var nowParent = t.byId.get(id).parent;
  document.getElementById('picker-sub').textContent =
    'Currently under ' +
    (nowParent === null ? 'no parent (top-level)' : labelOf('proposed', nowParent)) +
    (cn ? ' · originally ' + (cn.parent === null ? 'a top-level root' : labelOf('current', cn.parent))
        : ' · this is a proposed new category');
  document.getElementById('picker-reset').hidden = !cn;
  var why = document.getElementById('picker-why');
  why.value = isNew(id) ? (S.proposed.additions[String(id)].why || '')
            : (Object.prototype.hasOwnProperty.call(S.edits, String(id))
                ? (S.edits[String(id)].why || '')
                : (isMoved(id) ? (S.proposed.moves[String(id)].why || '') : ''));
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
    if (isNew(cid)) r.appendChild(el('span', 'flag new', 'NEW'));
    else r.appendChild(el('span', 'id', '#' + cid));
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

// ---------- rename / add ----------

var renameFor = null, addUnder = null;

function openRename(id) {
  renameFor = id;
  var t = S.trees.proposed, n = t.byId.get(id);
  document.getElementById('rename-title').textContent =
    (isNew(id) ? 'Rename proposed category' : 'Rename ' + originalName(id) + ' #' + id);
  document.getElementById('rename-sub').textContent = isNew(id)
    ? 'This category does not exist yet, so this just changes the proposal.'
    : 'The activity type ID stays #' + id + '. Only the display name changes, and only as a proposal.';
  var f = document.getElementById('rename-name');
  f.value = n.name;
  document.getElementById('rename-why').value =
    isNew(id) ? (S.proposed.additions[String(id)].why || '')
              : (isRenamed(id) ? (S.proposed.renames[String(id)].why || '') : '');
  document.getElementById('rename-revert').hidden = isNew(id) || !isRenamed(id);
  document.getElementById('rename').hidden = false;
  f.focus(); f.select();
}

function openAdd(parentId) {
  addUnder = parentId;
  document.getElementById('add-sub').textContent = parentId === null
    ? 'This will be added as a new top-level category.'
    : 'This will be added under ' + labelOf('proposed', parentId) + '.';
  document.getElementById('add-name').value = '';
  document.getElementById('add-why').value = '';
  document.getElementById('add').hidden = false;
  document.getElementById('add-name').focus();
}

// ---------- changes drawer + export ----------

function drawerRow(id, kind, bodyFn, undoFn) {
  var row = el('div', 'd-row' + (isEdited(id) ? ' mine' : ''));
  var head = el('div', 'd-head');
  if (isEdited(id)) head.appendChild(el('span', 'tag mine', 'your edit'));
  head.appendChild(el('span', 'nm', S.trees.proposed.byId.get(id).name));
  head.appendChild(isNew(id) ? el('span', 'flag new', 'NEW') : el('span', 'id', '#' + id));
  row.appendChild(head);
  bodyFn(row);
  var acts = el('div', 'd-acts');
  var go = el('button', null, 'Show');
  go.addEventListener('click', function () { closeDrawer(); select(id, true); });
  acts.appendChild(go);
  if (undoFn) {
    var un = el('button', 'danger', 'Undo my edit');
    un.addEventListener('click', undoFn);
    acts.appendChild(un);
  }
  row.appendChild(acts);
  return row;
}

function renderDrawer() {
  var host = document.getElementById('drawer-list');
  if (!host || !S.proposed) return;
  host.textContent = '';
  var moves = S.proposed.moves, renames = S.proposed.renames, adds = S.proposed.additions;

  var mine = Object.keys(S.edits).length + Object.keys(S.renames).length +
             Object.keys(S.additions).length;
  document.getElementById('drawer-sub').textContent =
    Object.keys(moves).length + ' moved · ' + Object.keys(renames).length + ' renamed · ' +
    Object.keys(adds).length + ' new · ' + mine +
    ' from your edits (stored in this browser only)';

  function section(title, count) {
    var h = el('div', 'd-section');
    h.appendChild(el('span', null, title));
    h.appendChild(el('span', 'cnt', String(count)));
    host.appendChild(h);
  }
  var mineFirst = function (a, b) {
    var ae = isEdited(a) ? 0 : 1, be = isEdited(b) ? 0 : 1;
    if (ae !== be) return ae - be;
    return S.trees.proposed.byId.get(a).name.localeCompare(S.trees.proposed.byId.get(b).name);
  };

  // --- new categories ---
  var addIds = Object.keys(adds).map(Number).sort(mineFirst);
  section('New categories', addIds.length);
  if (!addIds.length) host.appendChild(el('div', 'none', 'None.'));
  addIds.forEach(function (id) {
    host.appendChild(drawerRow(id, 'new', function (row) {
      var line = el('div', 'd-move');
      line.appendChild(el('span', 'newparent', 'new category'));
      line.appendChild(el('span', 'arrow', ' under '));
      line.appendChild(el('span', null, adds[String(id)].parent === null
        ? '(top level)' : labelOf('proposed', adds[String(id)].parent)));
      row.appendChild(line);
      row.appendChild(el('div', 'd-why warnrow',
        'Needs a real activity_type_id assigned at implementation.'));
      if (adds[String(id)].why) row.appendChild(el('div', 'd-why', adds[String(id)].why));
    }, Object.prototype.hasOwnProperty.call(S.additions, String(id))
        ? function () { removeAddition(id); } : null));
  });

  // --- renames ---
  var renIds = Object.keys(renames).map(Number).sort(mineFirst);
  section('Renamed', renIds.length);
  if (!renIds.length) host.appendChild(el('div', 'none', 'None.'));
  renIds.forEach(function (id) {
    host.appendChild(drawerRow(id, 'rename', function (row) {
      var line = el('div', 'd-move');
      line.appendChild(el('span', null, originalName(id)));
      line.appendChild(el('span', 'arrow', ' → '));
      line.appendChild(el('span', 'newparent', renames[String(id)].name));
      row.appendChild(line);
      if (renames[String(id)].why) row.appendChild(el('div', 'd-why', renames[String(id)].why));
    }, Object.prototype.hasOwnProperty.call(S.renames, String(id))
        ? function () { clearRename(id); } : null));
  });

  // --- moves ---
  var mvIds = Object.keys(moves).map(Number).sort(mineFirst);
  section('Re-parented', mvIds.length);
  if (!mvIds.length) host.appendChild(el('div', 'none', 'None.'));
  mvIds.forEach(function (id) {
    host.appendChild(drawerRow(id, 'move', function (row) {
      var from = S.trees.current.byId.get(id).parent;
      var line = el('div', 'd-move');
      line.appendChild(el('span', null, from === null ? '(root)' : labelOf('current', from)));
      line.appendChild(el('span', 'arrow', ' → '));
      line.appendChild(el('span', 'newparent', moves[String(id)].parent === null
        ? '(root)' : labelOf('proposed', moves[String(id)].parent)));
      row.appendChild(line);
      if (moves[String(id)].why) row.appendChild(el('div', 'd-why', moves[String(id)].why));
    }, Object.prototype.hasOwnProperty.call(S.edits, String(id))
        ? function () { clearEdit(id); } : null));
  });
}

function closeDrawer() { document.getElementById('drawer').hidden = true; }
function closeRename() { document.getElementById('rename').hidden = true; renameFor = null; }
function closeAdd() { document.getElementById('add').hidden = true; addUnder = null; }

function exportJson() {
  var moves = S.proposed.moves, renames = S.proposed.renames, adds = S.proposed.additions;
  var t = S.trees.proposed;
  var roots = t.roots.slice();
  var depth = depthOf(t);

  var out = {
    meta: {
      ticket: 'MMF-3280',
      basis: 'data/current.json',
      note: 'Applied to current.json. Existing activity types keep their ' +
            'ACTIVITY_TYPE_ID — only PARENT_ACTIVITY_TYPE_ID and, where listed under ' +
            '"renames", ACTIVITY_TYPE_NAME change. Entries under "additions" are new ' +
            'categories that do not exist yet; their negative ids are placeholders and ' +
            'must be replaced with real database-assigned ids at implementation.',
      moves: Object.keys(moves).length,
      renames: Object.keys(renames).length,
      additions: Object.keys(adds).length,
      roots_before: S.trees.current.roots.length,
      roots_after: roots.length,
      max_depth_before: S.current.meta.max_depth || 4,
      max_depth_after: depth,
      edited_in_browser: Object.keys(S.edits).length + Object.keys(S.renames).length +
                         Object.keys(S.additions).length
    },
    moves: {}, renames: {}, additions: {}
  };
  var numeric = function (a, b) { return a - b; };
  Object.keys(moves).map(Number).sort(numeric).forEach(function (id) {
    out.moves[String(id)] = {
      parent: moves[String(id)].parent,
      why: moves[String(id)].why || '',
      tier: moves[String(id)].tier || 'Manual edit'
    };
  });
  Object.keys(renames).map(Number).sort(numeric).forEach(function (id) {
    out.renames[String(id)] = {
      name: renames[String(id)].name,
      was: originalName(id),
      why: renames[String(id)].why || ''
    };
  });
  Object.keys(adds).map(Number).sort(numeric).forEach(function (id) {
    out.additions[String(id)] = {
      name: adds[String(id)].name,
      parent: adds[String(id)].parent,
      why: adds[String(id)].why || '',
      note: 'placeholder id — assign a real ACTIVITY_TYPE_ID at implementation'
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
    S.baseMoves = S.proposed.moves || {};
    S.baseRenames = S.proposed.renames || {};
    S.baseAdditions = S.proposed.additions || {};
    var st = loadEdits();
    S.edits = st.edits; S.renames = st.renames; S.additions = st.additions;
    rebuildProposed();
    var mine = Object.keys(S.edits).length + Object.keys(S.renames).length +
               Object.keys(S.additions).length;
    if (mine) {
      toast('Restored ' + mine + ' unsaved edit(s) from this browser. ' +
            'Open Changes to review or export.');
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
    var n = Object.keys(S.edits).length + Object.keys(S.renames).length +
            Object.keys(S.additions).length;
    if (!n) { toast('You have no edits to discard.'); return; }
    if (!confirm('Discard all ' + n +
                 ' of your local edits and return to the published proposal?')) return;
    S.edits = {}; S.renames = {}; S.additions = {};
    saveEdits();
    rebuildProposed();
    toast('Your edits were discarded.');
  });

  // --- rename / add wiring ---
  document.getElementById('rename-close').addEventListener('click', closeRename);
  document.getElementById('add-close').addEventListener('click', closeAdd);
  document.getElementById('rename-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (renameFor === null) return;
    var was = anyName(renameFor);
    if (setName(renameFor, document.getElementById('rename-name').value,
                document.getElementById('rename-why').value)) {
      toast('Renamed "' + was + '" → "' + anyName(renameFor) + '".');
      closeRename();
    }
  });
  document.getElementById('rename-revert').addEventListener('click', function () {
    if (renameFor === null || isNew(renameFor)) return;
    clearRename(renameFor);
    toast('Name reverted to "' + originalName(renameFor) + '".');
    closeRename();
  });
  document.getElementById('add-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var id = addChild(addUnder, document.getElementById('add-name').value,
                      document.getElementById('add-why').value);
    if (id !== null) {
      toast('Added "' + anyName(id) + '" — placeholder id, needs a real one at implementation.');
      closeAdd();
      select(id, true);
    }
  });
  document.getElementById('addroot').addEventListener('click', function () {
    if (!S.proposed) return;
    if (!S.editMode) document.getElementById('editmode').click();
    openAdd(null);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closePicker(); closeDrawer(); closeRename(); closeAdd(); }
  });

  var m = /^#id=(\d+)$/.exec(location.hash || '');
  if (m) {
    var id = Number(m[1]);
    if (S.trees.current.byId.has(id)) select(id, true);
  }
}

// ---------- loading: encrypted bundle, or plaintext for internal/local use ----------

// Data files change whenever the proposal is updated, and they keep the same URL.
// 'no-cache' still uses the cache but revalidates with the server first (ETag), so a
// stakeholder can never be shown a stale proposal without knowing it.
var NOCACHE = { cache: 'no-cache' };

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
  // Normalise before anything renders: proposal files predating renames/additions
  // omit those keys, and the render path reads them.
  if (proposed) {
    proposed.moves = proposed.moves || {};
    proposed.renames = proposed.renames || {};
    proposed.additions = proposed.additions || {};
  }
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
    // Decryption and start-up are caught separately: a bug in start-up must not be
    // reported to the user as a wrong password.
    decryptBundle(enc, pw.value).then(function (data) {
      try {
        startWithData(data.current, data.proposed);
      } catch (e) {
        msg.className = 'lock-msg bad';
        msg.textContent = 'Unlocked, but the page failed to start: ' + e.message;
        throw e;   // keep it in the console for debugging
      }
    }, function () {
      // AES-GCM authentication failure is indistinguishable from a wrong password,
      // which is exactly what we want to report.
      btn.disabled = false;
      msg.className = 'lock-msg bad';
      msg.textContent = 'That password did not work.';
      pw.select();
    });
  });
}

fetch('data/bundle.enc.json', NOCACHE)
  .then(function (r) { return r.ok ? r.json() : null; })
  .catch(function () { return null; })
  .then(function (enc) {
    if (enc) { showLock(enc); return; }
    // No encrypted bundle: internal build, load the plaintext files directly.
    return Promise.all([
      fetch('data/current.json', NOCACHE).then(function (r) {
        if (!r.ok) throw new Error('current.json ' + r.status);
        return r.json();
      }),
      fetch('data/proposed.json', NOCACHE).then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
    ]).then(function (res) { startWithData(res[0], res[1]); });
  })
  .catch(function (err) {
    document.getElementById('lock').hidden = true;
    document.getElementById('tree-current').appendChild(
      el('div', 'placeholder', 'Failed to load data: ' + err.message +
        ' — if you opened this file directly, serve it instead: python3 -m http.server'));
  });
