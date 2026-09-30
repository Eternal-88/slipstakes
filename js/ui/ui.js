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
      this._fit();
      window.addEventListener('resize', () => this._fit());
      G.Settings.on((k) => {
        // (after a pause: the slider sits inside the menu it's resizing)
        if (k !== 'uiScale') return;
        clearTimeout(this._fitT);
        this._fitT = setTimeout(() => this._fit(), 350);
      });
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
        if (!el || !this.cur || !this.cur.change) return;
        if (el._entered === el.value) return; // already committed by Enter
        el._entered = null;
        this.cur.change(el.dataset.change, el, e);
      });
      r.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const el = e.target.closest('[data-enter]');
          if (el) this.dispatch(el.dataset.enter, el, e);
          // Enter commits a number / text field (race count, race number)
          // and leaves it, so the screen can update again.
          const ch = e.target.closest('input[data-change]');
          if (ch && ch.type !== 'color') {
            e.preventDefault();
            ch._entered = ch.value;
            if (this.cur && this.cur.change) this.cur.change(ch.dataset.change, ch, e);
            ch.blur();
          }
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

    // Only touch the DOM when the markup actually changed — and never replace
    // a text box / dropdown the player is using. (Every state update used to
    // re-render the menu, swapping out the name field after each letter typed
    // and closing open dropdowns and colour pickers.) The new markup is held
    // back until focus leaves the field.
    patch(el, html) {
      if (!el) return;
      if (el._html === html) {
        el._deferred = null;
        return;
      }
      const a = document.activeElement;
      const editing = a && a !== document.body && el.contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || (a.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'range', 'submit'].includes(a.type)));
      if (editing) {
        el._deferred = html;
        if (!el._deferHook) {
          el._deferHook = true;
          el.addEventListener(
            'focusout',
            () =>
              setTimeout(() => {
                el._deferHook = false;
                if (el._deferred != null) {
                  const h = el._deferred;
                  el._deferred = null;
                  this.patch(el, h);
                }
              }, 0),
            { once: true }
          );
        }
        return;
      }
      el._deferred = null;
      el._html = html;
      el.innerHTML = html;
    },

    // v4.5: the interface is laid out for a 1366x768 screen (a Chromebook)
    // and zoomed to fit the real one. Bigger screens scale up a little less
    // than in proportion; tiny windows stop at 60% (and scroll).
    fitScale() {
      let f = Math.min(window.innerWidth / 1366, window.innerHeight / 768);
      if (f > 1) f = 1 + (f - 1) * 0.8;
      return U.clamp(f, 0.6, 1.6);
    },
    // Menus, pop-ups and toasts: CSS zoom --uiz (css/v4.css), times the
    // player's menu size. The HUD scales itself (hud.js) with the same fit.
    _fit() {
      const z = this.fitScale() * ((G.Settings.s.uiScale || 100) / 100);
      document.documentElement.style.setProperty('--uiz', z.toFixed(3));
    },

    // kind: info | good | bad | money (colour and sound). snd: false = silent,
    // or an Audio.notify() sound to play instead of the kind's.
    toast(msg, kind, snd) {
      const t = document.createElement('div');
      t.className = 'toast ' + (kind || 'info');
      t.textContent = msg;
      this.toastBox.appendChild(t);
      setTimeout(() => t.classList.add('out'), 2800);
      setTimeout(() => t.remove(), 3300);
      while (this.toastBox.children.length > 5) this.toastBox.firstChild.remove();
      const a = A();
      if (a && snd !== false) {
        if (typeof snd === 'string') a.notify(snd);
        else if (kind === 'bad') a.error();
        else if (kind === 'good') a.good();
        else if (kind === 'money') a.money();
        else a.notify('info');
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

    // One persistent notice bar (top centre) for things you're waiting on,
    // e.g. "Asking the host to let you in…" — with an optional Cancel.
    notice(html, onCancel) {
      this.clearNotice();
      const n = document.createElement('div');
      n.className = 'notice';
      n.innerHTML = `<span>${html}</span>` + (onCancel ? '<button class="btn small ghost">Cancel</button>' : '');
      if (onCancel)
        n.querySelector('button').addEventListener('click', () => {
          this.clearNotice();
          onCancel();
        });
      document.body.appendChild(n);
      this._notice = n;
    },
    clearNotice() {
      if (this._notice) this._notice.remove();
      this._notice = null;
    },

    async confirm(title, body, okLabel, danger) {
      const r = await this.modal(title, body, [{ label: 'Cancel', value: 0, cls: 'ghost' }, { label: okLabel || 'OK', value: 1, cls: danger ? 'red' : 'primary' }]);
      return !!r.value;
    },

    // v5.5.7 catch-up: Off / Mild / Wild, or any percentage typed in the box.
    // The screen handles input 'cuPreset' (the list) and change 'catchup' (the box).
    cuField(v, cls) {
      const p = G.Settings.cuPct(v) == null ? 10 : G.Settings.cuPct(v);
      const pre = [[0, 'Off'], [10, 'Mild'], [25, 'Wild']];
      const on = pre.find((x) => x[0] === p);
      return `<label class="fld cu-fld ${cls || ''}" title="Cars that fall behind get extra power, less drag, a little grip and longer gearing until they close the gap - full strength 60 m behind the car ahead. The leader never gets it, and it can't pass anyone for you. Mild is 10%, Wild 25% - or type any number from 0 to 100."><span>Catch-up</span><span class="cu-row"><select data-input="cuPreset">${pre.map(([n, l]) => `<option value="${n}" ${on && on[0] === n ? 'selected' : ''}>${l}</option>`).join('')}<option value="custom" ${on ? '' : 'selected'}>Custom</option></select><input class="num-in cu-num" type="number" min="0" max="100" step="1" value="${p}" data-change="catchup" aria-label="Catch-up, percent extra power"><em>%</em></span></label>`;
    },
    // what the catch-up field was set to: a whole percentage, or null (and a toast)
    cuRead(el) {
      if (el.dataset.input === 'cuPreset') {
        if (el.value === 'custom') {
          const n = el.parentNode.querySelector('.cu-num');
          if (n) n.focus(), n.select();
          return null;
        }
        return +el.value;
      }
      const p = String(el.value).trim() === '' ? null : G.Settings.cuPct(el.value);
      if (p == null || +el.value > 100 || +el.value < 0) {
        this.toast('Catch-up: type a number from 0 to 100.', 'bad');
        return null;
      }
      return p;
    },

    colorHex(c) {
      return '#' + (c >>> 0).toString(16).padStart(6, '0');
    },
  };

  G.UI = UI;
})(window.G);
