import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

export class AppFolderPins {
    constructor(settings, changed) {
        this._settings = settings;
        this._changed = changed;
        this._view = Main.overview._overview.controls.appDisplay;
        this._folders = new Gio.Settings({schema_id: 'org.gnome.desktop.app-folders'});
        this._menus = new Map();
        this._retiredMenus = new Set();
        this._folderWatches = new Map();
        this._injections = new InjectionManager();
        const pins = this;
        this._injections.overrideMethod(AppDisplay.AppDisplay.prototype, '_loadApps', original => function (...args) {
            // Let GNOME collect membership before filtering, so grouped apps do not escape into the grid.
            const items = original.apply(this, args);
            const pinned = new Set(pins._settings.get_strv('pinned-app-folders'));
            const hidden = items.filter(item => item instanceof AppDisplay.FolderIcon && pinned.has(item.id));
            this._folderIcons = this._folderIcons.filter(icon => !hidden.includes(icon));
            for (const icon of hidden) {
                // BaseAppView destroys existing items during redisplay; new hidden actors need our cleanup.
                if (this._items.get(icon.id) !== icon)
                    icon.destroy();
            }
            return items.filter(item => {
                if (hidden.includes(item)) return false;
                if (item instanceof AppDisplay.FolderIcon) pins._addMenu(item);
                return true;
            });
        });
        this._settingsId = settings.connect('changed::pinned-app-folders', () => this._queueRefresh());
        this._foldersId = this._folders.connect('changed::folder-children', () => this._queueRefresh());
        this._viewId = this._view.connect('view-loaded', () => this._queueRefresh(false));
        this._hidingId = Main.overview.connect('hiding', () => {
            for (const {menu} of this._menus.values()) menu.close();
        });
        this._view._redisplay();
    }

    _queueRefresh(redisplay = true) {
        this._needsRedisplay ||= redisplay;
        if (this._idleId) return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._needsRedisplay) {
                this._needsRedisplay = false;
                this._view._redisplay();
            }
            for (const icon of this._menus.keys()) {
                if (icon._dialog?._isOpen) {
                    icon.view._redisplay();
                    icon.icon.update();
                    icon.accessible_name = icon.name;
                }
            }
            this._idleId = 0;
            this._changed();
            return GLib.SOURCE_REMOVE;
        });
    }

    _setPinned(id, pinned) {
        const ids = this._settings.get_strv('pinned-app-folders').filter(value => value !== id);
        if (pinned) ids.push(id);
        this._settings.set_strv('pinned-app-folders', ids);
    }

    hasOpenDialog() {
        return [...this._menus.keys()].some(icon => icon._dialog?.visible);
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
            this._setPinned(icon.id, !this._settings.get_strv('pinned-app-folders').includes(icon.id));
        });
        const open = () => {
            const pinned = this._settings.get_strv('pinned-app-folders').includes(icon.id);
            item.label.text = pinned ? 'Unpin from Dock' : 'Pin to Dock';
            item.setSensitive(this._settings.is_writable('pinned-app-folders'));
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

    createButtons() {
        const existing = new Set(this._folders.get_strv('folder-children'));
        const ids = new Set(this._settings.get_strv('pinned-app-folders'));
        for (const [id, {settings, signal}] of this._folderWatches) {
            if (!ids.has(id) || !existing.has(id)) {
                settings.disconnect(signal);
                this._folderWatches.delete(id);
            }
        }
        const buttons = [];
        for (const id of ids) {
            if (!existing.has(id)) continue;
            if (!this._folderWatches.has(id)) {
                const settings = new Gio.Settings({
                    schema_id: 'org.gnome.desktop.app-folders.folder',
                    path: `${this._folders.path}folders/${id}/`,
                });
                this._folderWatches.set(id, {settings,
                    signal: settings.connect('changed', () => this._queueRefresh())});
            }
            const icon = new AppDisplay.FolderIcon(id, `${this._folders.path}folders/${id}/`, this._view);
            if (!icon.visible) {
                icon.destroy();
                continue;
            }
            icon.style_class = 'dash-stack-button dash-item-container dash-app-folder';
            icon.icon.remove_style_class_name('overview-icon-with-label');
            icon.icon.label.hide();
            icon.icon.setIconSize(64);
            icon.x_align = Clutter.ActorAlign.CENTER;
            icon.y_align = Clutter.ActorAlign.CENTER;
            icon.accessible_name = icon.name;
            if (icon._draggable) icon._draggable.inhibit = true;
            const open = icon.open.bind(icon);
            icon.open = () => {
                open();
                if (!icon._stacksDialogId) {
                    icon._stacksDialogId = icon._dialog.connect('notify::visible', dialog => {
                        if (!dialog.visible) this._queueRefresh();
                    });
                }
            };
            // Native folder views update through their parent AppDisplay; our separate dock view must follow it too.
            icon.connect('apps-changed', () => this._queueRefresh());
            this._addMenu(icon);
            buttons.push(icon);
        }
        return buttons;
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
            if (icon._stacksDialogId) icon._dialog.disconnect(icon._stacksDialogId);
            if (icon._dialog?._isOpen) icon._dialog.popdown();
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
