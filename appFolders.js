import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

// Adapt GNOME app-folder membership to the existing stack model and controls.
export class AppFolderPins {
    constructor(settings, changed) {
        this._settings = settings;
        this._changed = changed;
        this._view = Main.overview._overview.controls.appDisplay;
        this._folders = new Gio.Settings({schema_id: 'org.gnome.desktop.app-folders'});
        this._menus = new Map();
        this._retiredMenus = new Set();
        this._folderWatches = new Map();
        this._folderData = new Map();
        this._injections = new InjectionManager();
        this._migratePins();
        const pins = this;
        this._injections.overrideMethod(AppDisplay.AppDisplay.prototype, '_loadApps', original => function (...args) {
            const items = original.apply(this, args);
            const pinned = new Set(pins._stacks().map(stack => stack.appFolder).filter(Boolean));
            const hidden = items.filter(item => item instanceof AppDisplay.FolderIcon && pinned.has(item.id));
            pins._folderData.clear();
            this._folderIcons = this._folderIcons.filter(icon => !hidden.includes(icon));
            for (const icon of hidden) {
                pins._folderData.set(icon.id, {name: icon.name, apps: icon.view.getAllItems().map(item => item.app)});
                if (this._items.get(icon.id) !== icon) icon.destroy();
            }
            return items.filter(item => {
                if (hidden.includes(item)) return false;
                if (item instanceof AppDisplay.FolderIcon) pins._addMenu(item);
                return true;
            });
        });
        for (const method of ['handleDragOver', 'acceptDrop']) {
            this._injections.overrideMethod(Dash.Dash.prototype, method, original => function (source, ...args) {
                if (!pins.accepts(source)) return original.call(this, source, ...args);
                return method === 'handleDragOver' ? DND.DragMotionResult.MOVE_DROP : pins.drop(source);
            });
        }
        this._injections.overrideMethod(AppDisplay.AppDisplay.prototype, '_canAccept', original => function (source) {
            return source?._dashStack ? pins._settings.is_writable('stacks') : original.call(this, source);
        });
        this._injections.overrideMethod(AppDisplay.AppDisplay.prototype, 'acceptDrop', original => function (source, ...args) {
            if (!source?._dashStack) return original.call(this, source, ...args);
            if (!pins._settings.is_writable('stacks')) return false;
            const stacks = pins._stacks();
            stacks.splice(source._index, 1);
            return pins._settings.set_string('stacks', JSON.stringify(stacks));
        });
        this._settingsId = settings.connect('changed::stacks', () => this._queueRefresh());
        this._foldersId = this._folders.connect('changed::folder-children', () => this._queueRefresh());
        this._viewId = this._view.connect('view-loaded', () => this._queueRefresh(false));
        this._hidingId = Main.overview.connect('hiding', () => {
            for (const {menu} of this._menus.values()) menu.close();
        });
        this._syncWatches();
        this._view._redisplay();
    }

    _stacks() {
        try {
            const value = JSON.parse(this._settings.get_string('stacks'));
            return Array.isArray(value) ? value : [];
        } catch { return []; }
    }

    _migratePins() {
        const legacy = this._settings.get_strv('pinned-app-folders');
        if (!legacy.length || !this._settings.is_writable('stacks')) return;
        for (const id of new Set(legacy)) {
            if (!this._stacks().some(stack => stack.appFolder === id) && !this._setPinned(id, true)) return;
        }
        this._settings.set_strv('pinned-app-folders', []);
    }

    _setPinned(id, pinned) {
        const stacks = this._stacks().filter(stack => stack.appFolder !== id);
        if (pinned) {
            const folder = new Gio.Settings({schema_id: 'org.gnome.desktop.app-folders.folder',
                path: `${this._folders.path}folders/${id}/`});
            const name = folder.get_string('name');
            stacks.push({name: folder.get_boolean('translate') ? (Shell.util_get_translated_folder_name(name) ?? name) : name,
                appFolder: id, icon: 'folder', autoIcon: true});
        }
        return this._settings.set_string('stacks', JSON.stringify(stacks));
    }

    accepts(source) {
        return this._settings.is_writable('stacks') &&
            (source instanceof AppDisplay.FolderIcon || !!source?._dashStack || !!source?._folderPath);
    }

    drop(source, position = this._stacks().length) {
        if (!this.accepts(source)) return false;
        const stacks = this._stacks();
        const id = source instanceof AppDisplay.FolderIcon ? source.id : source.config?.appFolder;
        const old = source._dashStack ? source._index : stacks.findIndex(stack =>
            source._folderPath ? stack.path === source._folderPath : stack.appFolder === id);
        let entry;
        if (old >= 0) {
            [entry] = stacks.splice(old, 1);
            if (old < position) position--;
        } else {
            entry = source._folderPath
                ? {name: GLib.path_get_basename(source._folderPath), path: source._folderPath, icon: 'folder', autoIcon: false}
                : {name: source.name, appFolder: id, icon: 'folder', autoIcon: true};
        }
        stacks.splice(Math.max(0, Math.min(position, stacks.length)), 0, entry);
        return this._settings.set_string('stacks', JSON.stringify(stacks));
    }

    getFolder(id) { return this._folderData.get(id); }

    _syncWatches() {
        const ids = new Set(this._stacks().map(stack => stack.appFolder).filter(Boolean));
        for (const [id, {settings, signal}] of this._folderWatches) {
            if (!ids.has(id)) {
                settings.disconnect(signal);
                this._folderWatches.delete(id);
            }
        }
        for (const id of ids) {
            if (this._folderWatches.has(id)) continue;
            const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.app-folders.folder',
                path: `${this._folders.path}folders/${id}/`});
            this._folderWatches.set(id, {settings,
                signal: settings.connect('changed', () => this._queueRefresh())});
        }
    }

    _queueRefresh(redisplay = true) {
        this._needsRedisplay ||= redisplay;
        if (this._idleId) return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._syncWatches();
            if (this._needsRedisplay) {
                this._needsRedisplay = false;
                this._view._redisplay();
            }
            this._idleId = 0;
            this._changed();
            return GLib.SOURCE_REMOVE;
        });
    }

    _addMenu(icon) {
        if (this._menus.has(icon)) return;
        const menu = new PopupMenu.PopupMenu(icon, 0.5, St.Side.TOP);
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();
        const manager = new PopupMenu.PopupMenuManager(icon);
        manager.addMenu(menu);
        const item = new PopupMenu.PopupMenuItem('');
        menu.addMenuItem(item);
        item.connect('activate', () => {
            menu.close({animate: false});
            this._setPinned(icon.id, !this._stacks().some(stack => stack.appFolder === icon.id));
        });
        const open = () => {
            const pinned = this._stacks().some(stack => stack.appFolder === icon.id);
            item.label.text = pinned ? 'Unpin from Dock' : 'Pin to Dock';
            item.setSensitive(this._settings.is_writable('stacks'));
            menu.open();
            menu.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
        };
        const rightClick = new Clutter.ClickGesture({
            required_button: Clutter.BUTTON_SECONDARY,
            recognize_on_press: true,
        });
        rightClick.connect('recognize', open);
        icon.add_action(rightClick);
        const longPress = new Clutter.LongPressGesture();
        longPress.connect('recognize', open);
        icon.add_action(longPress);
        const keyboardId = icon.connect('popup-menu', open);
        const destroyId = icon.connect('destroy', () => {
            this._destroyMenu(menu);
            this._menus.delete(icon);
        });
        this._menus.set(icon, {menu, rightClick, longPress, keyboardId, destroyId});
    }

    _destroyMenu(menu) {
        menu.close({animate: false});
        menu.actor.remove_all_transitions();
        menu.actor.hide();
        this._retiredMenus.add(menu);
        if (this._menuCleanupId) return;
        // Let the pending layout finish before disposing a just-opened BoxPointer.
        this._menuCleanupId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._menuCleanupId = 0;
            for (const retired of this._retiredMenus) retired.destroy();
            this._retiredMenus.clear();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._idleId) GLib.source_remove(this._idleId);
        this._settings.disconnect(this._settingsId);
        this._folders.disconnect(this._foldersId);
        this._view.disconnect(this._viewId);
        Main.overview.disconnect(this._hidingId);
        this._injections.clear();
        for (const {settings, signal} of this._folderWatches.values()) settings.disconnect(signal);
        this._folderWatches.clear();
        for (const [icon, entry] of this._menus) {
            icon.disconnect(entry.keyboardId);
            icon.disconnect(entry.destroyId);
            icon.remove_action(entry.rightClick);
            icon.remove_action(entry.longPress);
            this._destroyMenu(entry.menu);
        }
        this._menus.clear();
        this._view._redisplay();
    }
}
