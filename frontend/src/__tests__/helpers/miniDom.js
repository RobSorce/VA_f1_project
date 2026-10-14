// Test helper: a minimal DOM for vitest's node environment (the project has
// no jsdom), enough for react-dom/client to mount a component and for D3
// (selection, axis, drag, transition) to draw into it and receive synthetic
// mouse events.
//
// SVG geometry follows the browser: getScreenCTM() of an SVG element is the
// outer <svg>'s viewport (its client rect and viewBox) composed with every
// translate / scale / rotate transform from the <svg> down to the element
// itself, so d3.pointer(event, node) returns coordinates in that node's user
// space exactly as a browser does. A test places the drawing on screen with
// setRect(element, {left, top, width, height}); an element without a rect
// reports the nearest ancestor's (a 100% x 100% svg fills its container).
//
// Usage (install before react-dom / d3 are imported, i.e. with dynamic imports):
//   const dom = installMiniDom();
//   const { createRoot } = await import('react-dom/client');
//   ...
//   dom.mouse(target, 'mousedown', { clientX, clientY, shiftKey: true });

const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_NS = 'http://www.w3.org/1999/xhtml';

// ── Events ────────────────────────────────────────────────────────────

class Target {
  constructor() { this._listeners = []; }

  addEventListener(type, fn, opts) {
    if (!fn) return;
    const capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
    if (this._listeners.some((l) => l.type === type && l.fn === fn && l.capture === capture)) return;
    this._listeners.push({ type, fn, capture, once: !!(opts && opts.once) });
  }

  removeEventListener(type, fn, opts) {
    const capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
    this._listeners = this._listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === capture));
  }

  dispatchEvent(event) { return dispatch(this, event); }
}

function parentOf(node) {
  if (node._isWindow) return null;
  if (node.nodeType === 9) return node.defaultView;
  return node.parentNode;
}

function invoke(node, event, phase) {
  event.currentTarget = node;
  event.eventPhase = phase === 'capture' ? 1 : phase === 'target' ? 2 : 3;
  for (const l of [...node._listeners]) {
    if (l.type !== event.type) continue;
    if (phase === 'capture' && !l.capture) continue;
    if (phase === 'bubble' && l.capture) continue;
    if (l.once) node.removeEventListener(l.type, l.fn, l.capture);
    if (typeof l.fn === 'function') l.fn.call(node, event);
    else if (l.fn && typeof l.fn.handleEvent === 'function') l.fn.handleEvent(event);
    if (event._stopImmediate) break;
  }
}

function dispatch(target, event) {
  const path = [];
  for (let n = target; n; n = parentOf(n)) path.push(n);
  event.target = target;
  for (let i = path.length - 1; i >= 1 && !event._stop; i--) invoke(path[i], event, 'capture');
  if (!event._stop) invoke(target, event, 'target');
  if (event.bubbles) {
    for (let i = 1; i < path.length && !event._stop; i++) invoke(path[i], event, 'bubble');
  }
  event.currentTarget = null;
  return !event.defaultPrevented;
}

function makeEvent(type, init = {}, view = null) {
  return {
    type,
    bubbles: init.bubbles ?? true,
    cancelable: true,
    composed: true,
    defaultPrevented: false,
    isTrusted: false,
    timeStamp: Date.now(),
    view,
    detail: init.detail ?? 1,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    pageX: init.clientX ?? 0,
    pageY: init.clientY ?? 0,
    screenX: init.clientX ?? 0,
    screenY: init.clientY ?? 0,
    shiftKey: !!init.shiftKey,
    ctrlKey: !!init.ctrlKey,
    altKey: !!init.altKey,
    metaKey: !!init.metaKey,
    button: init.button ?? 0,
    buttons: init.buttons ?? (type === 'mousemove' || type === 'mousedown' ? 1 : 0),
    relatedTarget: null,
    _stop: false,
    _stopImmediate: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this._stop = true; },
    stopImmediatePropagation() { this._stop = true; this._stopImmediate = true; },
    getModifierState(key) {
      return { Shift: this.shiftKey, Control: this.ctrlKey, Alt: this.altKey, Meta: this.metaKey }[key] || false;
    },
  };
}

// ── Affine matrices (a b c d e f, as SVGMatrix) ───────────────────────

function matrix(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) {
  return {
    a, b, c, d, e, f,
    multiply(m) {
      return matrix(
        this.a * m.a + this.c * m.b, this.b * m.a + this.d * m.b,
        this.a * m.c + this.c * m.d, this.b * m.c + this.d * m.d,
        this.a * m.e + this.c * m.f + this.e, this.b * m.e + this.d * m.f + this.f,
      );
    },
    inverse() {
      const det = this.a * this.d - this.b * this.c;
      return matrix(
        this.d / det, -this.b / det, -this.c / det, this.a / det,
        (this.c * this.f - this.d * this.e) / det, (this.b * this.e - this.a * this.f) / det,
      );
    },
  };
}

/** Matrix of an SVG transform attribute (translate, scale, rotate, matrix). */
export function parseTransform(str) {
  let m = matrix();
  if (!str) return m;
  const re = /(\w+)\s*\(([^)]*)\)/g;
  let hit;
  while ((hit = re.exec(str))) {
    const v = hit[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (hit[1] === 'translate') m = m.multiply(matrix(1, 0, 0, 1, v[0] || 0, v[1] || 0));
    else if (hit[1] === 'scale') m = m.multiply(matrix(v[0], 0, 0, v[1] ?? v[0], 0, 0));
    else if (hit[1] === 'rotate') {
      const r = ((v[0] || 0) * Math.PI) / 180;
      const rot = matrix(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0);
      if (v.length >= 3) {
        m = m.multiply(matrix(1, 0, 0, 1, v[1], v[2])).multiply(rot).multiply(matrix(1, 0, 0, 1, -v[1], -v[2]));
      } else m = m.multiply(rot);
    } else if (hit[1] === 'matrix') m = m.multiply(matrix(...v));
  }
  return m;
}

// ── Selectors (tag, #id, .class, [attr], [attr=value], :first-child,
//    descendant ' ' and child '>' combinators, comma groups) ─────────────

function parseCompound(src) {
  const c = { tag: null, id: null, classes: [], attrs: [], pseudo: [] };
  const re = /(^[\w*-]+)|#([\w-]+)|\.([\w-]+)|\[([\w-:]+)(?:([~|^$*]?=)["']?([^"'\]]*)["']?)?\]|:([\w-]+)/g;
  let hit;
  let consumed = 0;
  while ((hit = re.exec(src))) {
    if (hit.index !== consumed) throw new Error(`miniDom: unsupported selector "${src}"`);
    consumed = re.lastIndex;
    if (hit[1]) c.tag = hit[1] === '*' ? null : hit[1].toLowerCase();
    else if (hit[2]) c.id = hit[2];
    else if (hit[3]) c.classes.push(hit[3]);
    else if (hit[4]) c.attrs.push({ name: hit[4], op: hit[5], value: hit[6] });
    else if (hit[7]) c.pseudo.push(hit[7]);
  }
  if (consumed !== src.length) throw new Error(`miniDom: unsupported selector "${src}"`);
  return c;
}

function parseSelector(sel) {
  return sel.split(',').map((group) => {
    const tokens = group.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
    const parts = [];
    let comb = ' ';
    for (const t of tokens) {
      if (t === '>') { comb = '>'; continue; }
      parts.push({ comb, compound: parseCompound(t) });
      comb = ' ';
    }
    return parts;
  });
}

function matchesCompound(el, c) {
  if (!el || el.nodeType !== 1) return false;
  if (c.tag && el.localName.toLowerCase() !== c.tag) return false;
  if (c.id && el.getAttribute('id') !== c.id) return false;
  if (c.classes.length) {
    const cls = (el.getAttribute('class') || '').split(/\s+/);
    if (!c.classes.every((k) => cls.includes(k))) return false;
  }
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v == null) return false;
    if (a.op === '=' && v !== a.value) return false;
  }
  for (const p of c.pseudo) {
    const sibs = el.parentNode ? el.parentNode.children : [el];
    if (p === 'first-child' && sibs[0] !== el) return false;
    if (p === 'last-child' && sibs[sibs.length - 1] !== el) return false;
  }
  return true;
}

// As in a browser, the whole selector is matched against the document (the
// element querySelectorAll is called on only limits the candidates)
function matchesChain(el, parts, i) {
  if (!matchesCompound(el, parts[i].compound)) return false;
  if (i === 0) return true;
  if (parts[i].comb === '>') {
    const p = el.parentNode;
    return !!p && matchesChain(p, parts, i - 1);
  }
  for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) {
    if (matchesChain(p, parts, i - 1)) return true;
  }
  return false;
}

function matches(el, selector) {
  return parseSelector(selector).some((parts) => matchesChain(el, parts, parts.length - 1));
}

function descendants(node, out = []) {
  for (const c of node.childNodes) {
    if (c.nodeType === 1) { out.push(c); descendants(c, out); }
  }
  return out;
}

// ── Nodes ─────────────────────────────────────────────────────────────

class Style {
  setProperty(name, value) { this[name] = value == null ? '' : String(value); }
  getPropertyValue(name) { return this[name] == null ? '' : String(this[name]); }
  removeProperty(name) { const v = this.getPropertyValue(name); delete this[name]; return v; }
}

class Node extends Target {
  constructor(doc, nodeType, nodeName) {
    super();
    this.ownerDocument = doc;
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.parentNode = null;
    this.childNodes = [];
  }

  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get nextSibling() {
    const p = this.parentNode;
    return p ? p.childNodes[p.childNodes.indexOf(this) + 1] || null : null;
  }
  get previousSibling() {
    const p = this.parentNode;
    return p ? p.childNodes[p.childNodes.indexOf(this) - 1] || null : null;
  }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get isConnected() { return this.getRootNode().nodeType === 9; }

  appendChild(child) { return this.insertBefore(child, null); }

  insertBefore(child, ref) {
    if (child.nodeType === 11) {
      for (const k of [...child.childNodes]) this.insertBefore(k, ref);
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (ref && i < 0) throw new Error('miniDom: insertBefore reference is not a child');
    if (i < 0) this.childNodes.push(child);
    else this.childNodes.splice(i, 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i < 0) throw new Error('miniDom: removeChild of a node that is not a child');
    this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  replaceChild(next, old) { this.insertBefore(next, old); return this.removeChild(old); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  hasChildNodes() { return this.childNodes.length > 0; }
  getRootNode() { let n = this; while (n.parentNode) n = n.parentNode; return n; }

  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    if (v != null && v !== '') this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }

  compareDocumentPosition(other) {
    if (other === this) return 0;
    const chain = (n) => { const a = []; for (; n; n = n.parentNode) a.unshift(n); return a; };
    const a = chain(this);
    const b = chain(other);
    if (a[0] !== b[0]) return 1; // DISCONNECTED
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (i === a.length) return 4 | 16; // other is a descendant: FOLLOWING | CONTAINED_BY
    if (i === b.length) return 2 | 8; // other is an ancestor: PRECEDING | CONTAINS
    const p = a[i - 1].childNodes;
    return p.indexOf(b[i]) > p.indexOf(a[i]) ? 4 : 2;
  }
}

class Text extends Node {
  constructor(doc, data, nodeType = 3, nodeName = '#text') {
    super(doc, nodeType, nodeName);
    this.data = String(data);
  }
  get nodeValue() { return this.data; }
  set nodeValue(v) { this.data = String(v); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class ClassList {
  constructor(el) { this.el = el; }
  _get() { return (this.el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  _set(list) { this.el.setAttribute('class', list.join(' ')); }
  add(...names) { const l = this._get(); for (const n of names) if (!l.includes(n)) l.push(n); this._set(l); }
  remove(...names) { this._set(this._get().filter((n) => !names.includes(n))); }
  contains(n) { return this._get().includes(n); }
  toggle(n, force) {
    const has = this.contains(n);
    const want = force === undefined ? !has : !!force;
    if (want && !has) this.add(n);
    if (!want && has) this.remove(n);
    return want;
  }
}

class Element extends Node {
  constructor(doc, ns, name) {
    const local = ns === HTML_NS ? name.toLowerCase() : name;
    super(doc, 1, ns === HTML_NS ? local.toUpperCase() : local);
    this.namespaceURI = ns;
    this.localName = local;
    this.tagName = this.nodeName;
    this._attrs = new Map();
    this.style = new Style();
    this._rect = null;
    this._html = '';
  }

  getAttribute(n) { return this._attrs.has(n) ? this._attrs.get(n) : null; }
  setAttribute(n, v) { this._attrs.set(n, String(v)); }
  removeAttribute(n) { this._attrs.delete(n); }
  hasAttribute(n) { return this._attrs.has(n); }
  getAttributeNS(ns, n) { return this.getAttribute(n); }
  setAttributeNS(ns, n, v) { this.setAttribute(n, v); }
  removeAttributeNS(ns, n) { this.removeAttribute(n); }
  get attributes() { return [...this._attrs].map(([name, value]) => ({ name, value })); }
  getAttributeNames() { return [...this._attrs.keys()]; }

  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get classList() { return new ClassList(this); }

  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }

  get innerHTML() { return this._html; }
  set innerHTML(v) { this.textContent = ''; this._html = String(v); }

  matches(sel) { return matches(this, sel); }
  closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(sel)) return n; return null; }
  querySelectorAll(sel) { return descendants(this).filter((el) => matches(el, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getElementsByTagName(tag) { return this.querySelectorAll(tag); }

  focus() {}
  blur() {}

  getBoundingClientRect() {
    let n = this;
    while (n && n.nodeType === 1 && !n._rect) n = n.parentNode;
    const r = (n && n._rect) || { left: 0, top: 0, width: 0, height: 0 };
    return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height };
  }
  get clientWidth() { return this.getBoundingClientRect().width; }
  get clientHeight() { return this.getBoundingClientRect().height; }
  get clientLeft() { return 0; }
  get clientTop() { return 0; }
  get offsetWidth() { return this.clientWidth; }
  get offsetHeight() { return this.clientHeight; }

  // ── SVG ──
  get ownerSVGElement() {
    if (this.namespaceURI !== SVG_NS) return undefined;
    for (let p = this.parentNode; p && p.nodeType === 1; p = p.parentNode) {
      if (p.namespaceURI === SVG_NS && p.localName === 'svg') return p;
    }
    return null;
  }

  createSVGPoint() {
    return {
      x: 0,
      y: 0,
      matrixTransform(m) {
        return { x: m.a * this.x + m.c * this.y + m.e, y: m.b * this.x + m.d * this.y + m.f };
      },
    };
  }

  /** Browser rule: the outer svg's viewport (client rect + viewBox) times
   * every transform attribute from the svg down to this element. */
  getScreenCTM() {
    const chain = [];
    let n = this;
    for (; n && n.nodeType === 1 && n.namespaceURI === SVG_NS; n = n.parentNode) chain.unshift(n);
    const svg = chain.find((el) => el.localName === 'svg');
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    let m = matrix(1, 0, 0, 1, rect.left, rect.top);
    const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0 && rect.width > 0 && rect.height > 0) {
      // preserveAspectRatio xMidYMid meet
      const k = Math.min(rect.width / vb[2], rect.height / vb[3]);
      const tx = (rect.width - vb[2] * k) / 2;
      const ty = (rect.height - vb[3] * k) / 2;
      m = m.multiply(matrix(1, 0, 0, 1, tx, ty)).multiply(matrix(k, 0, 0, k, -vb[0] * k, -vb[1] * k));
    }
    for (const el of chain.slice(chain.indexOf(svg) + 1)) m = m.multiply(parseTransform(el.getAttribute('transform')));
    return m;
  }

  getCTM() { return this.getScreenCTM(); }
  getBBox() { return { x: 0, y: 0, width: 0, height: 0 }; }
  getComputedTextLength() { return this.textContent.length * 5; }
}

class Document extends Node {
  constructor() {
    super(null, 9, '#document');
    this.documentElement = this.createElement('html');
    this.head = this.createElement('head');
    this.body = this.createElement('body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    this.defaultView = null;
  }

  createElement(name) { return new Element(this, HTML_NS, name); }
  createElementNS(ns, name) { return new Element(this, ns || HTML_NS, name); }
  createTextNode(data) { return new Text(this, data); }
  createComment(data) { return new Text(this, data, 8, '#comment'); }
  createDocumentFragment() { return new Node(this, 11, '#document-fragment'); }
  get activeElement() { return this.body; }
  querySelectorAll(sel) {
    return [this.documentElement, ...descendants(this.documentElement)].filter((el) => matches(el, sel));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getElementById(id) { return this.querySelector(`#${id}`); }
}

/**
 * Install window / document / element classes on globalThis (idempotent per
 * module instance) and return the helpers of the test.
 */
export function installMiniDom() {
  const document = new Document();
  const window = new Target();
  window._isWindow = true;
  Object.assign(window, {
    document,
    window,
    self: window,
    navigator: globalThis.navigator,
    location: { href: 'http://localhost/', protocol: 'http:', host: 'localhost', hostname: 'localhost' },
    getComputedStyle: (el) => ({ getPropertyValue: (name) => el.style.getPropertyValue(name) }),
    HTMLElement: Element,
    HTMLIFrameElement: class HTMLIFrameElement {},
    SVGElement: Element,
    Element,
    Node,
    Text,
    setTimeout: (...a) => setTimeout(...a),
    clearTimeout: (...a) => clearTimeout(...a),
  });
  document.defaultView = window;

  globalThis.window = window;
  globalThis.document = document;
  globalThis.HTMLElement = Element;
  globalThis.HTMLIFrameElement = window.HTMLIFrameElement;
  globalThis.SVGElement = Element;
  globalThis.Element = Element;
  globalThis.Node = Node;
  globalThis.getComputedStyle = window.getComputedStyle;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  return {
    window,
    document,
    SVG_NS,
    /** Place an element on screen (client coordinates, CSS px). */
    setRect(el, rect) { el._rect = { left: 0, top: 0, width: 0, height: 0, ...rect }; },
    /** Dispatch a mouse event on target (an element or the window). */
    mouse(target, type, init = {}) {
      const ev = makeEvent(type, init, window);
      target.dispatchEvent(ev);
      return ev;
    },
    /** Client coordinates of a point given in el's user space. */
    toClient(el, x, y) {
      const m = el.getScreenCTM();
      return { clientX: m.a * x + m.c * y + m.e, clientY: m.b * x + m.d * y + m.f };
    },
    parseTransform,
  };
}
