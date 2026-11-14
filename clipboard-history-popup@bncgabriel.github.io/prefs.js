// SPDX-License-Identifier: GPL-2.0-or-later
// Preferences window.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SHORTCUT_KEY = 'toggle-clipboard';
const SUGGESTED_SHORTCUT = '<Super>v';

export default class ClipboardHistoryPopupPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(600, 640);

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'edit-paste-symbolic',
        });
        window.add(page);

        page.add(this._buildShortcutGroup(window, settings));
        page.add(this._buildAppearanceGroup(window, settings));
        page.add(this._buildHistoryGroup(settings));
    }

    // ---------- keyboard ----------

    _buildShortcutGroup(window, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Keyboard'),
            description: _('Esc always closes the popup.'),
        });

        const row = new Adw.ActionRow({
            title: _('Open the clipboard history'),
            subtitle: _('Super+V is suggested. Choosing it moves it away from the notification list, which stays on Super+M.'),
        });
        const label = new Gtk.ShortcutLabel({
            disabled_text: _('Not set'),
            valign: Gtk.Align.CENTER,
        });
        const useSuggested = new Gtk.Button({
            label: _('Use Super+V'),
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        const change = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            tooltip_text: _('Choose another shortcut'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        const clear = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: _('Remove the shortcut'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        row.add_suffix(label);
        row.add_suffix(useSuggested);
        row.add_suffix(change);
        row.add_suffix(clear);
        group.add(row);

        const sync = () => {
            const accel = settings.get_strv(SHORTCUT_KEY)[0] ?? '';
            label.accelerator = accel;
            useSuggested.visible = accel.toLowerCase() !== SUGGESTED_SHORTCUT.toLowerCase();
            clear.sensitive = accel !== '';
        };
        sync();
        const changedId = settings.connect(`changed::${SHORTCUT_KEY}`, sync);
        window.connect('close-request', () => {
            settings.disconnect(changedId);
            return false;
        });

        useSuggested.connect('clicked', () => settings.set_strv(SHORTCUT_KEY, [SUGGESTED_SHORTCUT]));
        clear.connect('clicked', () => settings.set_strv(SHORTCUT_KEY, []));
        change.connect('clicked', () => this._captureShortcut(window, settings));

        const keyboardRow = new Adw.SwitchRow({
            title: _('Keyboard operations'),
            subtitle: _('↑ ↓ to move · Enter to paste · Delete/Backspace to delete · P to pin'),
        });
        settings.bind('keyboard-shortcuts', keyboardRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(keyboardRow);

        return group;
    }

    _captureShortcut(parent, settings) {
        const dialog = new Adw.Window({
            transient_for: parent,
            modal: true,
            resizable: false,
            default_width: 420,
            title: _('New shortcut'),
        });
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 32,
            margin_bottom: 32,
            margin_start: 32,
            margin_end: 32,
        });
        box.append(new Gtk.Label({
            label: _('Press the new shortcut'),
            css_classes: ['title-3'],
        }));
        box.append(new Gtk.Label({
            label: _('Esc to cancel · Backspace to remove the shortcut'),
            css_classes: ['dim-label'],
        }));
        const content = new Adw.ToolbarView({content: box});
        content.add_top_bar(new Adw.HeaderBar());
        dialog.set_content(content);

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_c, keyval, keycode, state) => {
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            const key = Gdk.keyval_to_lower(keyval);

            if (!mods && key === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (!mods && key === Gdk.KEY_BackSpace) {
                settings.set_strv(SHORTCUT_KEY, []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            // Require a modifier so a plain letter can't hijack normal typing.
            if (mods && Gtk.accelerator_valid(key, mods)) {
                settings.set_strv(SHORTCUT_KEY, [Gtk.accelerator_name(key, mods)]);
                dialog.close();
            }
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);
        dialog.present();
    }

    // ---------- appearance ----------

    _buildAppearanceGroup(window, settings) {
        const themes = [
            ['light', _('Light')],
            ['dark', _('Dark')],
            ['auto', _('Follow the system style')],
        ];
        const group = new Adw.PreferencesGroup({title: _('Appearance')});
        const row = new Adw.ComboRow({
            title: _('Theme'),
            model: Gtk.StringList.new(themes.map(([, name]) => name)),
        });
        const sync = () => {
            const idx = Math.max(0, themes.findIndex(([value]) => value === settings.get_string('theme')));
            if (row.selected !== idx)
                row.selected = idx;
        };
        sync();
        row.connect('notify::selected', () => {
            const value = themes[row.selected]?.[0] ?? 'light';
            if (settings.get_string('theme') !== value)
                settings.set_string('theme', value);
        });
        const changedId = settings.connect('changed::theme', sync);
        window.connect('close-request', () => {
            settings.disconnect(changedId);
            return false;
        });
        group.add(row);
        return group;
    }

    // ---------- history ----------

    _buildHistoryGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('History'),
            description: _('The history stays on this computer. Unpinned items are cleared on logout or reboot.'),
        });

        const images = new Adw.SwitchRow({
            title: _('Save images'),
            subtitle: _('Keep copied images in the history, with a preview'),
        });
        settings.bind('save-images', images, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(images);

        const size = new Adw.SpinRow({
            title: _('History size'),
            subtitle: _('Maximum number of unpinned items'),
            adjustment: new Gtk.Adjustment({lower: 5, upper: 200, step_increment: 1, page_increment: 10}),
        });
        settings.bind('history-size', size, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(size);

        return group;
    }
}
