// ui.js — tiny screen manager. Screens render HTML strings into containers;
// clicks are delegated through data-act attributes, so there's no per-element
// listener bookkeeping and re-rendering is always safe. Also: UI sounds on
// hover/click, toasts (with sounds), and modal dialogs (Esc cancels).
'use strict';
(function (G) {
  const U = G.U;
  const A = () => G.Audio;

  const UI = {
    screens: {},
    cur: null,
    curName: null,
    arg: null,
    _dirty: false,
    globalActs: {},

    init() {
      this.root = document.getElementById('ui');
      this.toastBox = document.getElementById('toasts');
      const r = this.root;
      r.addEventListener('click', (e) => {
        const el = e.target.closest('[data-act]');
        if (!el || el.disabled || el.classList.contains('disabled')) return;
        if (A() && !el.dataset.silent) A().click();
        this.dispatch(el.dataset.act, el, e);
      });
      let lastHover = null;
      r.addEventListener('mouseover', (e) => {
        const el = e.target.closest('[data-hover]');
        if (this.cur && this.cur.hover) this.cur.hover(el, e);
        const b = e.target.closest('button, [data-act]');
        if (b && b !== lastHover && !b.disabled && A()) A().hover();
        lastHover = b;
      });
      r.addEventListener('input', (e) => {
        const el = e.target.closest('[data-input]');
        if (el && this.cur && this.cur.input) this.cur.input(el.dataset.input, el, e);
      });
      r.addEventListener('change', (e) => {
        const el = e.target.closest('[data-change]');
        if (el && this.cur && this.cur.change) this.cur.change(el.dataset.change, el, e);
      });
      r.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const el = e.target.closest('[data-enter]');
          if (el) this.dispatch(el.dataset.enter, el, e);
        }
      });
    },

    register(name, screen) {
      this.screens[name] = screen;
    },

    show(name, arg) {
      if (this.cur && this.cur.unmount) this.cur.unmount();
      this.cur = this.screens[name];
      this.curName = name;
      this.arg = arg;
      this.root.innerHTML = '';
      this.root.className = 'scr scr-' + name;
      this.root.style.display = '';
      if (this.cur.mount) this.cur.mount(this.root, arg);
      this.refresh(true);
    },

    hide() {
      if (this.cur && this.cur.unmount) this.cur.unmount();
      this.cur = null;
      this.curName = null;
      this.root.innerHTML = '';
      this.root.className = '';
      this.root.style.display = 'none';
    },

    // Mark dirty (re-render next frame) or render immediately.
    refresh(now) {
      if (!this.cur) return;
      if (now) {
        if (this.cur.render) this.cur.render(this.root, this.arg);
      } else this._dirty = true;
    },

    update(dt) {
      if (this._dirty) {
        this._dirty = false;
        this.refresh(true);
      }
      if (this.cur && this.cur.update) this.cur.update(dt);
    },

    dispatch(act, el, e) {
      if (this.cur && this.cur.acts && this.cur.acts[act]) this.cur.acts[act].call(this.cur, el, e);
      else if (this.globalActs[act]) this.globalActs[act](el, e);
    },

    // Only touch the DOM when the markup actually changed.
    patch(el, html) {
      if (!el) return;
      if (el._html === html) return;
      el._html = html;
      el.innerHTML = html;
    },

    toast(msg, kind) {
      const t = document.createElement('div');
      t.className = 'toast ' + (kind || 'info');
      t.textContent = msg;
      this.toastBox.appendChild(t);
      setTimeout(() => t.classList.add('out'), 2800);
      setTimeout(() => t.remove(), 3300);
      while (this.toastBox.children.length > 5) this.toastBox.firstChild.remove();
      const a = A();
      if (a) {
        if (kind === 'bad') a.error();
        else if (kind === 'good') a.good();
        else if (kind === 'money') a.money();
      }
    },

    // Modal dialog. buttons: [{label, value, cls}] → resolves with value.
    // Esc (or clicking the backdrop) picks the first button (always "Cancel").
    modal(title, bodyHtml, buttons) {
      return new Promise((resolve) => {
        const m = document.createElement('div');
        m.className = 'modal-bg';
        m.innerHTML = `<div class="modal"><h2>${U.esc(title)}</h2><div class="modal-body">${bodyHtml}</div><div class="modal-btns">${buttons
          .map((b, i) => `<button class="btn ${b.cls || ''}" data-i="${i}">${U.esc(b.label)}</button>`)
          .join('')}</div></div>`;
        const done = (i) => {
          const inputs = {};
          m.querySelectorAll('input,select').forEach((x) => (inputs[x.name] = x.value));
          m.remove();
          window.removeEventListener('keydown', onKey, true);
          resolve({ value: buttons[i].value, inputs });
        };
        const onKey = (e) => {
          if (e.key === 'Escape') {
            e.stopImmediatePropagation();
            e.preventDefault();
            done(0);
          } else if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
            e.preventDefault();
            done(buttons.length - 1);
          }
        };
        window.addEventListener('keydown', onKey, true);
        m.addEventListener('click', (e) => {
          if (e.target === m) return done(0);
          const b = e.target.closest('button[data-i]');
          if (!b) return;
          if (A()) A().click();
          done(+b.dataset.i);
        });
        document.body.appendChild(m);
        const first = m.querySelector('input');
        if (first) first.focus();
      });
    },

    async confirm(title, body, okLabel, danger) {
      const r = await this.modal(title, body, [{ label: 'Cancel', value: 0, cls: 'ghost' }, { label: okLabel || 'OK', value: 1, cls: danger ? 'red' : 'primary' }]);
      return !!r.value;
    },

    colorHex(c) {
      return '#' + (c >>> 0).toString(16).padStart(6, '0');
    },
  };

  G.UI = UI;
})(window.G);
