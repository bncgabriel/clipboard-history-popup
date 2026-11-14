// SPDX-License-Identifier: GPL-2.0-or-later
// Clipboard history storage.
//
// - Pinned items: ~/.local/share/clipboard-history-popup/pinned.json (kept across reboots)
// - Full history: $XDG_RUNTIME_DIR/clipboard-history-popup/history.json
//   (a tmpfs that is cleared on logout/reboot, but survives the lock screen)
// - Images: ~/.local/share/clipboard-history-popup/images/<sha256>.<ext>
//   (images of unpinned items are deleted the next time the extension starts)

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MAX_TEXT_CHARS = 1_000_000;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

const EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
};

function readJson(path) {
    try {
        const [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
        if (!ok)
            return null;
        return JSON.parse(new TextDecoder().decode(contents));
    } catch {
        return null;
    }
}

function writeFile(path, data) {
    try {
        Gio.File.new_for_path(path).replace_contents(
            data, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE,
            null);
        return true;
    } catch (e) {
        console.error(`[clipboard-history-popup] failed to write ${path}: ${e.message}`);
        return false;
    }
}

export class ClipboardStore {
    constructor(name, maxHistory = 25) {
        this.maxHistory = maxHistory;
        this._dataDir = GLib.build_filenamev([GLib.get_user_data_dir(), name]);
        this._imagesDir = GLib.build_filenamev([this._dataDir, 'images']);
        this._runtimeDir = GLib.build_filenamev([GLib.get_user_runtime_dir(), name]);
        GLib.mkdir_with_parents(this._imagesDir, 0o700);
        GLib.mkdir_with_parents(this._runtimeDir, 0o700);

        this._pinnedFile = GLib.build_filenamev([this._dataDir, 'pinned.json']);
        this._historyFile = GLib.build_filenamev([this._runtimeDir, 'history.json']);

        this.items = [];
        this._load();
    }

    // ---------- reading ----------

    imagePath(item) {
        return GLib.build_filenamev([this._imagesDir, item.file]);
    }

    readImage(item) {
        try {
            const [, contents] = Gio.File.new_for_path(this.imagePath(item)).load_contents(null);
            return new GLib.Bytes(contents);
        } catch (e) {
            console.error(`[clipboard-history-popup] failed to read image: ${e.message}`);
            return null;
        }
    }

    // ---------- adding ----------

    addText(text) {
        if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_CHARS)
            return false;
        const hash = `t-${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, text, -1)}`;
        return this._add({type: 'text', text, hash});
    }

    addImage(bytes, mime) {
        const size = bytes?.get_size() ?? 0;
        if (size === 0 || size > MAX_IMAGE_BYTES)
            return false;

        const hash = `i-${GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes)}`;
        const ext = EXTENSIONS[mime] ?? 'img';
        const file = `${hash}.${ext}`;

        if (!this.items.some(i => i.hash === hash)) {
            const path = GLib.build_filenamev([this._imagesDir, file]);
            if (!writeFile(path, bytes.toArray()))
                return false;
        }
        return this._add({type: 'image', file, mime, hash});
    }

    _add(entry) {
        const idx = this.items.findIndex(i => i.hash === entry.hash);
        if (idx === 0)
            return false;

        if (idx > 0) {
            // A pinned item copied again stays where it is (at the end).
            if (this.items[idx].pinned)
                return false;
            const [existing] = this.items.splice(idx, 1);
            this.items.unshift(existing);
        } else {
            entry.pinned = false;
            entry.time = Date.now();
            this.items.unshift(entry);
            this._order();
            this._trim();
        }
        this._save();
        return true;
    }

    // ---------- actions ----------

    togglePin(item) {
        item.pinned = !item.pinned;
        // A newly pinned item goes to the end; an unpinned one goes back to the top.
        this.items = this.items.filter(i => i !== item);
        if (item.pinned)
            this.items.push(item);
        else
            this.items.unshift(item);
        this._order();
        this._trim();
        this._save();
    }

    // Unpinned items first (most recent first), pinned items at the end.
    _order() {
        this.items = [...this.items.filter(i => !i.pinned), ...this.items.filter(i => i.pinned)];
    }

    remove(item) {
        this.items = this.items.filter(i => i !== item);
        this._deleteImage(item);
        this._save();
    }

    clearUnpinned() {
        for (const item of this.items.filter(i => !i.pinned))
            this._deleteImage(item);
        this.items = this.items.filter(i => i.pinned);
        this._save();
    }

    // ---------- internals ----------

    _trim() {
        let unpinned = 0;
        this.items = this.items.filter(item => {
            if (item.pinned)
                return true;
            unpinned++;
            if (unpinned <= this.maxHistory)
                return true;
            this._deleteImage(item);
            return false;
        });
    }

    _deleteImage(item) {
        if (item.type !== 'image')
            return;
        try {
            Gio.File.new_for_path(this.imagePath(item)).delete(null);
        } catch {}
    }

    _isValid(item) {
        if (!item || typeof item.hash !== 'string')
            return false;
        if (item.type === 'text')
            return typeof item.text === 'string';
        if (item.type === 'image')
            return typeof item.file === 'string' &&
                GLib.file_test(this.imagePath(item), GLib.FileTest.EXISTS);
        return false;
    }

    _load() {
        const history = readJson(this._historyFile) ?? [];
        const pinned = readJson(this._pinnedFile) ?? [];
        const pinnedHashes = new Set(pinned.map(i => i?.hash));
        const seen = new Set();
        const items = [];

        // The current session history (if any) keeps its order.
        for (const item of history) {
            if (!this._isValid(item) || seen.has(item.hash))
                continue;
            item.pinned = pinnedHashes.has(item.hash);
            seen.add(item.hash);
            items.push(item);
        }
        // Pinned items missing from it (e.g. after a reboot).
        for (const item of pinned) {
            if (!this._isValid(item) || seen.has(item.hash))
                continue;
            item.pinned = true;
            seen.add(item.hash);
            items.push(item);
        }

        this.items = items;
        this._order();
        this._trim();
        this._collectGarbage();
        this._save();
    }

    // Delete images that no item refers to (e.g. unpinned ones after a reboot).
    _collectGarbage() {
        const keep = new Set(this.items.filter(i => i.type === 'image').map(i => i.file));
        try {
            const dir = Gio.File.new_for_path(this._imagesDir);
            const en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null))) {
                const name = info.get_name();
                if (!keep.has(name))
                    dir.get_child(name).delete(null);
            }
            en.close(null);
        } catch (e) {
            console.error(`[clipboard-history-popup] image cleanup: ${e.message}`);
        }
    }

    _save() {
        const enc = new TextEncoder();
        writeFile(this._historyFile, enc.encode(JSON.stringify(this.items)));
        writeFile(this._pinnedFile, enc.encode(JSON.stringify(this.items.filter(i => i.pinned))));
    }
}
