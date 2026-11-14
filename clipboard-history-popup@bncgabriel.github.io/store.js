// SPDX-License-Identifier: GPL-2.0-or-later
// Clipboard history storage.
//
// - Pinned items: ~/.local/share/clipboard-history-popup/pinned.json (kept across reboots)
// - Full history: $XDG_RUNTIME_DIR/clipboard-history-popup/history.json
//   (a tmpfs that is cleared on logout/reboot, but survives the lock screen)
// - Images: ~/.local/share/clipboard-history-popup/images/<sha256>.<ext>
//   (images of unpinned items are deleted the next time the extension starts)
//
// All file access is asynchronous so the Shell never blocks on disk IO.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

const MAX_TEXT_CHARS = 1_000_000;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const WRITE_FLAGS = Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE;

const EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
};

function logError(what, e) {
    console.error(`[clipboard-history-popup] ${what}: ${e.message}`);
}

async function readJson(path) {
    try {
        const [contents] = await Gio.File.new_for_path(path).load_contents_async(null);
        return JSON.parse(new TextDecoder().decode(contents));
    } catch {
        return null; // missing or unreadable file: start empty
    }
}

function writeBytes(path, bytes) {
    return Gio.File.new_for_path(path)
        .replace_contents_bytes_async(bytes, null, false, WRITE_FLAGS, null);
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
        this._writeQueue = Promise.resolve();
    }

    // ---------- loading ----------

    async load() {
        const [history, pinned, existingImages] = await Promise.all([
            readJson(this._historyFile),
            readJson(this._pinnedFile),
            this._listImages(),
        ]);
        const pinnedHashes = new Set((pinned ?? []).map(i => i?.hash));
        const isValid = item => {
            if (!item || typeof item.hash !== 'string')
                return false;
            if (item.type === 'text')
                return typeof item.text === 'string';
            if (item.type === 'image')
                return existingImages.has(item.file);
            return false;
        };

        // Items copied while loading stay first.
        const seen = new Set(this.items.map(i => i.hash));
        const loaded = [];
        // The current session history keeps its order...
        for (const item of history ?? []) {
            if (!isValid(item) || seen.has(item.hash))
                continue;
            item.pinned = pinnedHashes.has(item.hash);
            seen.add(item.hash);
            loaded.push(item);
        }
        // ...then pinned items missing from it (e.g. after a reboot).
        for (const item of pinned ?? []) {
            if (!isValid(item) || seen.has(item.hash))
                continue;
            item.pinned = true;
            seen.add(item.hash);
            loaded.push(item);
        }

        this.items = [...this.items, ...loaded];
        this._order();
        this._trim();
        this._save();

        // Delete images no item refers to (e.g. unpinned ones after a reboot).
        const keep = new Set(this.items.filter(i => i.type === 'image').map(i => i.file));
        for (const name of existingImages) {
            if (!keep.has(name))
                this._deleteFile(GLib.build_filenamev([this._imagesDir, name]));
        }
    }

    async _listImages() {
        const names = new Set();
        try {
            const dir = Gio.File.new_for_path(this._imagesDir);
            const en = await dir.enumerate_children_async('standard::name',
                Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
            let infos;
            while ((infos = await en.next_files_async(50, GLib.PRIORITY_DEFAULT, null)).length) {
                for (const info of infos)
                    names.add(info.get_name());
            }
        } catch (e) {
            logError('failed to list images', e);
        }
        return names;
    }

    // ---------- reading ----------

    imagePath(item) {
        return GLib.build_filenamev([this._imagesDir, item.file]);
    }

    async readImage(item) {
        try {
            const [contents] = await Gio.File.new_for_path(this.imagePath(item)).load_contents_async(null);
            return new GLib.Bytes(contents);
        } catch (e) {
            logError('failed to read image', e);
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

    async addImage(bytes, mime) {
        const size = bytes?.get_size() ?? 0;
        if (size === 0 || size > MAX_IMAGE_BYTES)
            return false;

        const hash = `i-${GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes)}`;
        const file = `${hash}.${EXTENSIONS[mime] ?? 'img'}`;

        if (!this.items.some(i => i.hash === hash)) {
            try {
                await writeBytes(GLib.build_filenamev([this._imagesDir, file]), bytes);
            } catch (e) {
                logError('failed to save image', e);
                return false;
            }
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

    // Unpinned items first (most recent first), pinned items at the end.
    _order() {
        this.items = [...this.items.filter(i => !i.pinned), ...this.items.filter(i => i.pinned)];
    }

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
        if (item.type === 'image')
            this._deleteFile(this.imagePath(item));
    }

    _deleteFile(path) {
        Gio.File.new_for_path(path).delete_async(GLib.PRIORITY_DEFAULT, null)
            .catch(e => logError('failed to delete file', e));
    }

    // Writes are queued so an older snapshot never overwrites a newer one.
    _save() {
        const enc = new TextEncoder();
        const history = new GLib.Bytes(enc.encode(JSON.stringify(this.items)));
        const pinned = new GLib.Bytes(enc.encode(JSON.stringify(this.items.filter(i => i.pinned))));
        this._writeQueue = this._writeQueue
            .then(() => Promise.all([
                writeBytes(this._historyFile, history),
                writeBytes(this._pinnedFile, pinned),
            ]))
            .catch(e => logError('failed to save history', e));
    }
}
