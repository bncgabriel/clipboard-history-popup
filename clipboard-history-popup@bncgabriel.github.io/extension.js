// SPDX-License-Identifier: GPL-2.0-or-later
// Clipboard History Popup: a floating clipboard history opened next to the text cursor.

import Atspi from 'gi://Atspi';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ClipboardStore} from './store.js';
import {ClipboardPopup} from './popup.js';

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff'];
const TEXT_MIMES = ['text/plain;charset=utf-8', 'text/plain', 'UTF8_STRING', 'STRING', 'TEXT'];
// Terminals paste with Ctrl+Shift+V instead of Ctrl+V.
const TERMINALS = ['terminal', 'ptyxis', 'kgx', 'console', 'tilix', 'kitty', 'alacritty',
    'konsole', 'wezterm', 'foot', 'ghostty', 'terminator', 'xterm'];
const SUPER_V = '<super>v';
const SHORTCUT_KEY = 'toggle-clipboard';

export default class ClipboardHistoryPopupExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._store = new ClipboardStore('clipboard-history-popup', this._settings.get_int('history-size'));
        this._clipboard = St.Clipboard.get_default();
        this._timeouts = new Set();
        this._readTimeoutId = 0;
        this._popup = null;

        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect('owner-changed',
            (_sel, type) => this._onOwnerChanged(type));

        this._createVirtualKeyboard();
        this._trackTextCursor();
        this._startAccessibilityTracking();

        this._bindShortcut();
        this._shortcutChangedId = this._settings.connect(`changed::${SHORTCUT_KEY}`,
            () => this._bindShortcut());
        this._sizeChangedId = this._settings.connect('changed::history-size',
            () => (this._store.maxHistory = this._settings.get_int('history-size')));
    }

    disable() {
        Main.wm.removeKeybinding(SHORTCUT_KEY);
        this._popup?.close();
        this._popup = null;

        this._settings.disconnect(this._shortcutChangedId);
        this._settings.disconnect(this._sizeChangedId);
        this._selection.disconnect(this._ownerChangedId);
        if (this._imCursorId)
            Main.inputMethod.disconnect(this._imCursorId);
        this._imCursorId = 0;
        this._stopAccessibilityTracking();

        if (this._readTimeoutId)
            GLib.source_remove(this._readTimeoutId);
        this._readTimeoutId = 0;
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();

        this._restoreSuperV();

        this._virtualKeyboard = null;
        this._selection = null;
        this._clipboard = null;
        this._caret = null;
        this._caretWindow = null;
        this._targetWindow = null;
        this._store = null;
        this._settings = null;
    }

    // ---------- shortcut ----------

    _bindShortcut() {
        Main.wm.removeKeybinding(SHORTCUT_KEY);
        Main.wm.addKeybinding(SHORTCUT_KEY, this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._toggle());

        const usesSuperV = this._settings.get_strv(SHORTCUT_KEY)
            .some(a => a.toLowerCase() === SUPER_V);
        if (usesSuperV)
            this._takeSuperV();
        else
            this._restoreSuperV();
    }

    // GNOME Shell binds Super+V to the notification list by default. When the user
    // picks Super+V for this extension, it is removed there and given back on disable.
    // The flag is stored in GSettings so the binding is restored even after a crash.
    _takeSuperV() {
        try {
            const keys = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});
            const current = keys.get_strv('toggle-message-tray');
            const filtered = current.filter(a => a.toLowerCase() !== SUPER_V);
            if (filtered.length !== current.length) {
                keys.set_strv('toggle-message-tray', filtered);
                this._settings.set_boolean('restore-super-v', true);
            }
        } catch (e) {
            console.error(`[${this.uuid}] failed to free Super+V: ${e.message}`);
        }
    }

    _restoreSuperV() {
        try {
            if (!this._settings.get_boolean('restore-super-v'))
                return;
            const keys = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});
            const current = keys.get_strv('toggle-message-tray');
            if (!current.some(a => a.toLowerCase() === SUPER_V))
                keys.set_strv('toggle-message-tray', ['<Super>v', ...current]);
            this._settings.set_boolean('restore-super-v', false);
        } catch (e) {
            console.error(`[${this.uuid}] failed to restore Super+V: ${e.message}`);
        }
    }

    // ---------- reading the clipboard ----------

    _onOwnerChanged(type) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD)
            return;
        // Some apps replace the clipboard several times in a row; read once it settles.
        if (this._readTimeoutId)
            GLib.source_remove(this._readTimeoutId);
        this._readTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            this._readTimeoutId = 0;
            try {
                this._readClipboard();
            } catch (e) {
                console.error(`[${this.uuid}] failed to read the clipboard: ${e.message}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _readClipboard() {
        const mimes = this._clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD) ?? [];
        if (!mimes.length)
            return;
        // Password managers (KeePassXC and others) mark secrets with this hint.
        if (mimes.includes('x-kde-passwordManagerHint'))
            return;

        if (mimes.some(m => TEXT_MIMES.includes(m) || m.startsWith('text/plain'))) {
            this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (_cb, text) => {
                if (this._store && text)
                    this._store.addText(text);
            });
            return;
        }

        if (!this._settings.get_boolean('save-images'))
            return;

        const imageMime = IMAGE_MIMES.find(m => mimes.includes(m)) ??
            mimes.find(m => m.startsWith('image/'));
        if (imageMime) {
            this._clipboard.get_content(St.ClipboardType.CLIPBOARD, imageMime, (_cb, bytes) => {
                if (this._store && bytes)
                    this._store.addImage(bytes, imageMime);
            });
        }
    }

    // ---------- text cursor position ----------

    // Native Wayland apps (GTK, Qt, Chromium/Electron with Wayland) report the
    // text cursor rectangle, in screen coordinates, through the input method.
    _trackTextCursor() {
        this._caret = null;
        this._caretWindow = null;
        this._imCursorId = Main.inputMethod.connect('cursor-location-changed', (_im, rect) => {
            this._caret = {x: rect.get_x(), y: rect.get_y(), w: rect.get_width(), h: rect.get_height()};
            this._caretWindow = global.display.focus_window;
        });
    }

    // X11 apps don't use that path, so the caret is taken from AT-SPI instead,
    // the same way the GNOME magnifier follows the text cursor.
    _startAccessibilityTracking() {
        this._atspiSources = [];
        this._atspiEvents = ['object:text-caret-moved', 'object:state-changed:focused'];
        try {
            Atspi.init();
            this._atspiListener = Atspi.EventListener.new(event => {
                if (event.type.startsWith('object:state-changed') && !event.detail1)
                    return;
                // Keep a few recent sources: GNOME Shell itself also emits focus events.
                const list = this._atspiSources.filter(a => a !== event.source);
                list.unshift(event.source);
                this._atspiSources = list.slice(0, 8);
            });
            for (const e of this._atspiEvents)
                this._atspiListener.register(e);
        } catch (e) {
            this._atspiListener = null;
            console.error(`[${this.uuid}] AT-SPI unavailable: ${e.message}`);
        }
    }

    _stopAccessibilityTracking() {
        try {
            for (const e of this._atspiEvents ?? [])
                this._atspiListener?.deregister(e);
        } catch {}
        this._atspiListener = null;
        this._atspiSources = [];
    }

    _atspiCaret(window) {
        if (!window || window.get_client_type() !== Meta.WindowClientType.X11)
            return null;
        const pid = window.get_pid();
        for (const acc of this._atspiSources) {
            try {
                if (acc.get_process_id() !== pid)
                    continue;
                const text = acc.get_text_iface();
                if (!text)
                    continue;
                const offset = text.get_caret_offset();
                let r = text.get_character_extents(offset, Atspi.CoordType.SCREEN);
                if (r.width <= 0 && r.height <= 0 && offset > 0) {
                    // Caret at the end of the text: use the previous character.
                    const prev = text.get_character_extents(offset - 1, Atspi.CoordType.SCREEN);
                    r = {x: prev.x + prev.width, y: prev.y, width: 1, height: prev.height};
                }
                if (r.x <= 0 && r.y <= 0)
                    continue;
                return {x: r.x, y: r.y, w: Math.max(r.width, 1), h: Math.max(r.height, 1)};
            } catch {
                // The app went away or doesn't implement the Text interface.
            }
        }
        return null;
    }

    _anchor() {
        const focus = global.display.focus_window;
        const c = this._caret;
        if (c && focus && this._caretWindow === focus && (c.x > 0 || c.y > 0))
            return c;

        const a11y = this._atspiCaret(focus);
        if (a11y)
            return a11y;

        const [x, y] = global.get_pointer();
        return {x, y, w: 0, h: 0};
    }

    // ---------- popup ----------

    _isDark() {
        const theme = this._settings.get_string('theme');
        if (theme !== 'auto')
            return theme === 'dark';
        const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        return iface.get_string('color-scheme') === 'prefer-dark';
    }

    _toggle() {
        if (this._popup) {
            this._popup.close();
            return;
        }
        this._targetWindow = global.display.focus_window;
        let popup = null;
        try {
            popup = new ClipboardPopup(this._store, {
                iconsDir: `${this.path}/icons`,
                dark: this._isDark(),
                keyboard: this._settings.get_boolean('keyboard-shortcuts'),
                onPaste: item => this._pasteItem(item),
                onClosed: () => {
                    if (this._popup === popup)
                        this._popup = null;
                },
            });
            this._popup = popup;
            if (!popup.open(this._anchor()))
                this._popup = null;
        } catch (e) {
            console.error(`[${this.uuid}] failed to open the popup: ${e.message}\n${e.stack}`);
            popup?.close();
            this._popup = null;
        }
    }

    // ---------- pasting ----------

    _pasteItem(item) {
        if (item.type === 'text') {
            this._clipboard.set_text(St.ClipboardType.CLIPBOARD, item.text);
        } else {
            const bytes = this._store.readImage(item);
            if (!bytes)
                return;
            this._clipboard.set_content(St.ClipboardType.CLIPBOARD, item.mime ?? 'image/png', bytes);
        }

        const wmClass = (this._targetWindow?.get_wm_class() ?? '').toLowerCase();
        const terminal = TERMINALS.some(t => wmClass.includes(t));
        this._popup?.close();

        // Give the focus back to the app before sending the paste shortcut.
        this._schedule(120, () => this._sendPasteKeys(terminal));
    }

    _createVirtualKeyboard() {
        const backend = global.stage?.context?.get_backend?.() ?? Clutter.get_default_backend();
        this._virtualKeyboard = backend.get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    }

    _sendPasteKeys(terminal) {
        const keys = terminal
            ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v]
            : [Clutter.KEY_Control_L, Clutter.KEY_v];
        const time = GLib.get_monotonic_time();
        for (const k of keys)
            this._virtualKeyboard.notify_keyval(time, k, Clutter.KeyState.PRESSED);
        for (const k of [...keys].reverse())
            this._virtualKeyboard.notify_keyval(time, k, Clutter.KeyState.RELEASED);
    }

    _schedule(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }
}
