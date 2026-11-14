// SPDX-License-Identifier: GPL-2.0-or-later
// The floating clipboard history popup.

import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const WIDTH = 360;        // logical px
const HEIGHT = 440;
const GAP = 6;
const THUMB_HEIGHT = 64;
const THUMB_MAX_WIDTH = 240;
const PREVIEW_CHARS = 160;
const PREVIEW_LINES = 3;


// St.BoxLayout replaced "vertical" with "orientation" in GNOME 48.
function vbox(params = {}) {
    const box = new St.BoxLayout(params);
    if ('orientation' in box)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}

function previewText(text) {
    let lines = text.replace(/\t/g, '    ').trim().split(/\r?\n/);
    const cut = lines.length > PREVIEW_LINES;
    lines = lines.slice(0, PREVIEW_LINES);
    let out = lines.join('\n');
    if (out.length > PREVIEW_CHARS)
        return `${out.slice(0, PREVIEW_CHARS).trimEnd()}…`;
    if (cut)
        out += '…';
    return out;
}

// A minimal button that behaves the same on every supported GNOME version.
function clickable(params, onClick) {
    const w = new St.Bin({reactive: true, track_hover: true, ...params});
    let pressed = false;
    w.connect('button-press-event', (_a, event) => {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        pressed = true;
        return Clutter.EVENT_STOP;
    });
    w.connect('leave-event', () => {
        pressed = false;
        return Clutter.EVENT_PROPAGATE;
    });
    w.connect('button-release-event', (_a, event) => {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        if (pressed) {
            pressed = false;
            onClick();
        }
        return Clutter.EVENT_STOP;
    });
    return w;
}

export class ClipboardPopup {
    constructor(store, {iconsDir, dark, keyboard = true, onPaste, onClosed}) {
        this._store = store;
        this._iconsDir = iconsDir;
        this._dark = dark;
        this._keyboard = keyboard;
        this._onPaste = onPaste;
        this._onClosed = onClosed;
        this._rows = [];
        this._rowItems = [];
        this._selected = 0;
        this._menu = null;
        this._confirm = null;
        this._grab = null;
        this._closed = false;
        this._build();
    }

    // ---------- icons ----------

    _icon(name, accent = false, size = 16) {
        const suffix = accent === 'danger' ? '-danger' : accent ? '-accent' : '';
        const variant = `${this._dark ? 'dark' : 'light'}${suffix}`;
        const file = Gio.File.new_for_path(`${this._iconsDir}/${name}-${variant}.svg`);
        return new St.Icon({gicon: new Gio.FileIcon({file}), icon_size: size});
    }

    // ---------- building ----------

    _build() {
        // Invisible full-screen backdrop: clicking outside the popup closes it.
        this._backdrop = new St.Widget({
            reactive: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        this._backdrop.connect('button-press-event', () => {
            this.close();
            return Clutter.EVENT_STOP;
        });
        this._backdrop.connect('key-press-event', (_a, event) => this._onKeyPress(event));

        this._popup = vbox({
            style_class: `cbw-popup ${this._dark ? 'cbw-dark' : 'cbw-light'}`,
            reactive: true,
        });
        this._popup.connect('button-press-event', () => {
            this._closeMenu();
            return Clutter.EVENT_STOP;
        });
        this._backdrop.add_child(this._popup);

        // Header: title and "Clear all".
        const header = new St.BoxLayout({style_class: 'cbw-header', x_expand: true});
        header.add_child(new St.Label({
            text: _('Clipboard'),
            style_class: 'cbw-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const clearBtn = clickable({
            style_class: 'cbw-clear',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Label({text: _('Clear all')}),
        }, () => this._clearAll());
        header.add_child(clearBtn);
        this._popup.add_child(header);

        // Scrollable list of cards.
        this._list = vbox({style_class: 'cbw-list', x_expand: true});
        this._scroll = new St.ScrollView({
            style_class: 'cbw-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        if (typeof this._scroll.set_child === 'function')
            this._scroll.set_child(this._list);
        else
            this._scroll.add_actor(this._list);
        this._popup.add_child(this._scroll);
    }

    _rebuild() {
        this._closeMenu();
        this._list.destroy_all_children();
        this._rows = [];
        this._rowItems = [];

        const items = this._store.items;
        if (!items.length) {
            const empty = vbox({style_class: 'cbw-empty', x_expand: true});
            empty.add_child(new St.Label({
                text: _('You haven’t copied anything yet'),
                style_class: 'cbw-empty-title',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            empty.add_child(new St.Label({
                text: _('When you copy something, it will show up here.'),
                style_class: 'cbw-empty-text',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            this._list.add_child(empty);
            return;
        }

        items.forEach((item, index) => {
            let row;
            try {
                row = this._makeRow(item, index);
            } catch (e) {
                // One broken item must not prevent the popup from opening.
                console.error(`[clipboard-history-popup] failed to build item ${index}: ${e.message}`);
                return;
            }
            this._list.add_child(row);
            this._rows.push(row);
            this._rowItems.push(item);
        });
        this._select(Math.min(this._selected, this._rows.length - 1), false);
    }

    _makeRow(item, index) {
        const row = new St.BoxLayout({
            style_class: item.pinned ? 'cbw-item pinned' : 'cbw-item',
            reactive: true,
            track_hover: true,
            x_expand: true,
        });

        const content = clickable({
            style_class: 'cbw-item-content',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            child: this._makePreview(item),
        }, () => this._onPaste(item));
        row.add_child(content);

        // Right column: "⋯" menu on top, pin at the bottom.
        const side = vbox({style_class: 'cbw-side'});
        const moreBtn = clickable({
            style_class: 'cbw-icon-btn',
            x_align: Clutter.ActorAlign.END,
            child: this._icon('more'),
        }, () => {
            this._select(index, false);
            this._openMenu(item, moreBtn);
        });
        side.add_child(moreBtn);

        side.add_child(new St.Widget({y_expand: true}));

        const bottom = new St.BoxLayout({style_class: 'cbw-side-bottom'});
        bottom.add_child(clickable({
            style_class: item.pinned ? 'cbw-icon-btn cbw-pin active' : 'cbw-icon-btn cbw-pin',
            child: this._icon(item.pinned ? 'pinned' : 'pin', item.pinned),
        }, () => {
            this._togglePin(item);
        }));
        side.add_child(bottom);

        row.add_child(side);
        return row;
    }

    _makePreview(item) {
        if (item.type === 'image') {
            const path = this._store.imagePath(item);
            let w = THUMB_MAX_WIDTH, h = THUMB_HEIGHT;
            try {
                const [, iw, ih] = GdkPixbuf.Pixbuf.get_file_info(path);
                if (iw > 0 && ih > 0) {
                    h = Math.min(THUMB_HEIGHT, ih);
                    w = Math.min(THUMB_MAX_WIDTH, Math.round(h * iw / ih));
                }
            } catch {}
            const uri = Gio.File.new_for_path(path).get_uri();
            const box = new St.BoxLayout({x_expand: true});
            box.add_child(new St.Widget({
                style_class: 'cbw-image',
                style: `background-image: url("${uri}"); width: ${w}px; height: ${h}px;`,
            }));
            return box;
        }

        const label = new St.Label({
            text: previewText(item.text),
            style_class: 'cbw-text',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        return label;
    }

    // ---------- "⋯" menu ----------

    _openMenu(item, anchorActor) {
        this._closeMenu();
        const menu = vbox({
            style_class: `cbw-menu ${this._dark ? 'cbw-dark' : 'cbw-light'}`,
            reactive: true,
        });
        menu.connect('button-press-event', () => Clutter.EVENT_STOP);

        const addEntry = (icon, accent, text, action, extraClass = '') => {
            const box = new St.BoxLayout({style_class: 'cbw-menu-box'});
            box.add_child(this._icon(icon, accent));
            box.add_child(new St.Label({text, y_align: Clutter.ActorAlign.CENTER}));
            menu.add_child(clickable({
                style_class: `cbw-menu-item ${extraClass}`,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                child: box,
            }, () => {
                this._closeMenu();
                action();
            }));
        };
        addEntry('trash', 'danger', _('Delete'), () => this._requestRemove(item), 'cbw-danger');

        this._backdrop.add_child(menu);
        this._menu = menu;

        const [ax, ay] = anchorActor.get_transformed_position();
        const [aw, ah] = anchorActor.get_transformed_size();
        const [, natW] = menu.get_preferred_width(-1);
        const [, natH] = menu.get_preferred_height(natW);
        let x = ax + aw - natW;
        let y = ay + ah + 2;
        if (y + natH > global.stage.height)
            y = ay - natH - 2;
        menu.set_position(Math.round(Math.max(0, x)), Math.round(Math.max(0, y)));
    }

    _closeMenu() {
        this._menu?.destroy();
        this._menu = null;
    }

    // ---------- actions ----------

    // Deleting a pinned item asks for confirmation first.
    _requestRemove(item) {
        if (!item.pinned) {
            this._remove(item);
            return;
        }
        this._closeMenu();
        this._closeConfirm();

        const theme = this._dark ? 'cbw-dark' : 'cbw-light';
        const overlay = new St.Widget({
            style_class: `cbw-confirm-overlay ${theme}`,
            reactive: true,
            layout_manager: new Clutter.BinLayout(),
        });
        overlay.connect('button-press-event', () => Clutter.EVENT_STOP);
        const [px, py] = this._popup.get_position();
        const [pw, ph] = this._popup.get_size();
        overlay.set_position(px, py);
        overlay.set_size(pw, ph);

        const dialog = vbox({
            style_class: `cbw-confirm ${theme}`,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        dialog.add_child(new St.Label({text: _('Do you really want to delete this pinned item?'), style_class: 'cbw-confirm-title'}));
        const msg = new St.Label({
            text: _('This item is pinned and will no longer be\nkept after a restart.'),
            style_class: 'cbw-confirm-text',
        });
        dialog.add_child(msg);

        const accept = () => {
            this._closeConfirm();
            this._remove(item);
        };
        const buttons = new St.BoxLayout({style_class: 'cbw-confirm-buttons', x_align: Clutter.ActorAlign.END});
        buttons.add_child(clickable({
            style_class: 'cbw-confirm-btn',
            child: new St.Label({text: _('Cancel')}),
        }, () => this._closeConfirm()));
        buttons.add_child(clickable({
            style_class: 'cbw-confirm-btn cbw-confirm-danger',
            child: new St.Label({text: _('Delete')}),
        }, accept));
        dialog.add_child(buttons);

        overlay.add_child(dialog);
        this._backdrop.add_child(overlay);
        this._confirm = {actor: overlay, accept};
    }

    _closeConfirm() {
        this._confirm?.actor.destroy();
        this._confirm = null;
    }

    _remove(item) {
        this._store.remove(item);
        this._rebuild();
    }

    _togglePin(item) {
        this._store.togglePin(item);
        this._selected = Math.max(0, this._store.items.indexOf(item));
        this._rebuild();
        if (this._rows[this._selected])
            this._scrollTo(this._rows[this._selected]);
    }

    _clearAll() {
        this._store.clearUnpinned();
        this._selected = 0;
        this._rebuild();
    }

    // ---------- selection and keyboard ----------

    _select(index, scroll = true) {
        if (!this._rows.length)
            return;
        index = Math.max(0, Math.min(index, this._rows.length - 1));
        this._rows[this._selected]?.remove_style_class_name('selected');
        this._selected = index;
        const row = this._rows[index];
        // The selection outline only makes sense with keyboard navigation.
        if (this._keyboard)
            row.add_style_class_name('selected');
        if (scroll)
            this._scrollTo(row);
    }

    _scrollTo(row) {
        const adj = this._scroll.vadjustment ?? this._scroll.vscroll?.adjustment;
        if (!adj)
            return;
        const box = row.get_allocation_box();
        let value = adj.value;
        if (box.y1 < value)
            value = box.y1;
        else if (box.y2 > value + adj.page_size)
            value = box.y2 - adj.page_size;
        adj.set_value(value);
    }

    _onKeyPress(event) {
        const sym = event.get_key_symbol();
        if (this._confirm) {
            if (sym === Clutter.KEY_Escape)
                this._closeConfirm();
            else if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter || sym === Clutter.KEY_ISO_Enter)
                this._confirm.accept();
            return Clutter.EVENT_STOP;
        }
        const state = event.get_state();
        // With keyboard operations disabled, only closing the popup is handled.
        if (!this._keyboard) {
            const superOn = state & (Clutter.ModifierType.MOD4_MASK | Clutter.ModifierType.SUPER_MASK);
            if (sym === Clutter.KEY_Escape || ((sym === Clutter.KEY_v || sym === Clutter.KEY_V) && superOn)) {
                if (this._menu)
                    this._closeMenu();
                else
                    this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }
        const item = this._rowItems[this._selected];
        const superHeld = state & (Clutter.ModifierType.MOD4_MASK | Clutter.ModifierType.SUPER_MASK);

        switch (sym) {
        case Clutter.KEY_Escape:
            if (this._menu)
                this._closeMenu();
            else
                this.close();
            break;
        case Clutter.KEY_v:
        case Clutter.KEY_V:
            if (superHeld)
                this.close(); // pressing Super+V again closes the popup
            break;
        case Clutter.KEY_Up:
        case Clutter.KEY_KP_Up:
            this._closeMenu();
            this._select(this._selected - 1);
            break;
        case Clutter.KEY_Down:
        case Clutter.KEY_KP_Down:
            this._closeMenu();
            this._select(this._selected + 1);
            break;
        case Clutter.KEY_Home:
            this._select(0);
            break;
        case Clutter.KEY_End:
            this._select(this._rows.length - 1);
            break;
        case Clutter.KEY_Page_Up:
            this._select(this._selected - 4);
            break;
        case Clutter.KEY_Page_Down:
            this._select(this._selected + 4);
            break;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
            if (item)
                this._onPaste(item);
            break;
        case Clutter.KEY_Delete:
        case Clutter.KEY_KP_Delete:
        case Clutter.KEY_BackSpace:
            if (item)
                this._requestRemove(item);
            break;
        case Clutter.KEY_p:
        case Clutter.KEY_P:
            if (item)
                this._togglePin(item);
            break;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_STOP;
    }

    // ---------- open and close ----------

    open(anchor) {
        Main.uiGroup.add_child(this._backdrop);

        this._grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.POPUP});
        // get_seat_state() is not available on newer GNOME versions.
        const grabOk = typeof this._grab?.get_seat_state !== 'function' ||
            (this._grab.get_seat_state() & Clutter.GrabState.KEYBOARD) !== 0;
        if (!grabOk) {
            this.close();
            return false;
        }

        // Place the popup before filling it.
        this._place(anchor);
        this._rebuild();
        this._backdrop.grab_key_focus();

        this._popup.opacity = 0;
        this._popup.ease({
            opacity: 255,
            duration: 110,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        return true;
    }

    _place(anchor) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const monitors = Main.layoutManager.monitors;
        let monitorIndex = monitors.findIndex(m =>
            anchor.x >= m.x && anchor.x < m.x + m.width &&
            anchor.y >= m.y && anchor.y < m.y + m.height);
        if (monitorIndex < 0)
            monitorIndex = Main.layoutManager.primaryIndex;
        const wa = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);

        const gap = GAP * scale;
        const w = Math.min(WIDTH * scale, wa.width - 2 * gap);
        let h = Math.min(HEIGHT * scale, wa.height - 2 * gap);

        // Below the text cursor, left-aligned with it. Otherwise above it. If it
        // fits on neither side, use the larger side and shrink the popup so it
        // never covers the field being typed in.
        const below = wa.y + wa.height - gap - (anchor.y + anchor.h + gap);
        const above = anchor.y - gap - (wa.y + gap);
        let y;
        if (h <= below) {
            y = anchor.y + anchor.h + gap;
        } else if (h <= above) {
            y = anchor.y - gap - h;
        } else if (below >= above) {
            h = Math.max(below, 180 * scale);
            y = anchor.y + anchor.h + gap;
        } else {
            h = Math.max(above, 180 * scale);
            y = anchor.y - gap - h;
        }
        this._popup.set_size(Math.round(w), Math.round(h));

        let x = Math.max(wa.x + gap, Math.min(anchor.x, wa.x + wa.width - w - gap));
        y = Math.max(wa.y + gap, Math.min(y, wa.y + wa.height - h - gap));
        this._popup.set_position(Math.round(x), Math.round(y));
    }

    close() {
        if (this._closed)
            return;
        this._closed = true;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._backdrop?.destroy();
        this._backdrop = null;
        this._menu = null;
        this._confirm = null;
        this._onClosed?.();
    }
}
