import {StackContents, allStacks, stackKey, stackPath, copyLauncher, linkDirectory, removeFile} from './stackContents.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
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
        this._jobs = new Set();
        this._disposed = false;
        this.contents = new StackContents(redisplay => this._queueRefresh(redisplay));
        this._migratePins();
        const pins = this;
        this._injections.overrideMethod(AppDisplay.AppDisplay.prototype, '_loadApps', original => function (...args) {
            const items = original.apply(this, args);
            const pinned = new Set(allStacks(pins._stacks()).map(stack => stack.appFolder).filter(Boolean));
            const hidden = items.filter(item => item instanceof AppDisplay.FolderIcon && (pinned.has(item.id) || item.view.getAllItems().length===0));
            pins._folderData.clear();
            this._folderIcons = this._folderIcons.filter(icon => !hidden.includes(icon));
            for (const icon of hidden) {
                pins._folderData.set(icon.id, {name: icon.name, apps: icon.view.getAllItems().map(item => item.app)});
                if (this._items.get(icon.id) !== icon) icon.destroy();
            }
            return items.filter(item => {
                if(hidden.includes(item))return false;
                if(item.app&&pins.contents.hidden.has(item.app.get_id())){
                    if(this._items.get(item.id)!==item)item.destroy();
                    return false;
                }
                if (item instanceof AppDisplay.FolderIcon) pins._addMenu(item);
                return true;
            });
        });
        this._injections.overrideMethod(AppDisplay.FolderView.prototype, '_loadApps', original => function (...args) {
            const items=original.apply(this,args);
            const id=this._id;
            if(allStacks(pins._stacks()).some(stack=>stack.appFolder===id))return items;
            return items.filter(item=>{
                if(!item.app||!pins.contents.hidden.has(item.app.get_id()))return true;
                if(this._items.get(item.id)!==item)item.destroy();
                return false;
            });
        });
        this._injections.overrideMethod(Dash.Dash, 'getAppFromSource', original => function (source) {
            return source?._stackApp ?? original.call(this,source);
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
            pins.removeStack(source).catch(error=>Main.notifyError('Could not remove stack',error.message));
            return true;
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

    descriptor(source) {
        if(source?._stackConfig)return source._stackConfig;
        if(source?._dashStack)return source.config;
        if(source instanceof AppDisplay.FolderIcon)return {name:source.name,appFolder:source.id,icon:'folder',autoIcon:true};
        if(source?._folderPath)return {name:GLib.path_get_basename(source._folderPath),path:source._folderPath,icon:'folder',autoIcon:false};
        return null;
    }
    find(stacks,key) {
        for(let index=0;index<stacks.length;index++){
            if(stackKey(stacks[index])===key)return {list:stacks,index,stack:stacks[index]};
            const child=this.find(stacks[index].children??[],key);if(child)return child;
        }
        return null;
    }
    accepts(source) { return this._settings.is_writable('stacks') && !!this.descriptor(source); }
    drop(source, position = this._stacks().length) {
        if(!this.accepts(source))return false;
        this._promote(source,position).catch(error=>Main.notifyError('Could not pin stack',error.message));
        return true;
    }
    async _removeShortcut(stack) {
        if(!stack.shortcutTarget)return;
        const file=Gio.File.new_for_path(stackPath(stack));
        let info;
        try{info=await new Promise((resolve,reject)=>file.query_info_async('standard::type,standard::symlink-target',Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,GLib.PRIORITY_DEFAULT,null,(f,r)=>{try{resolve(f.query_info_finish(r));}catch(e){reject(e);}}));}
        catch(error){if(error.matches(Gio.IOErrorEnum,Gio.IOErrorEnum.NOT_FOUND))return;throw error;}
        if(info.get_file_type()===Gio.FileType.SYMBOLIC_LINK&&info.get_symlink_target()===stack.shortcutTarget)await removeFile(file);
    }
    _relocate(stack,from,to) {
        const entry={...stack};
        const path=stackPath(entry);
        if(path&&(path===from||path.startsWith(from+'/')))entry.path=to+path.slice(from.length);
        if(entry.children)entry.children=entry.children.map(child=>this._relocate(child,from,to));
        return entry;
    }
    async _promote(source,position) {
        const descriptor=this.descriptor(source);
        if(this._disposed)return;
        const stacks=this._stacks(),found=this.find(stacks,stackKey(descriptor));
        let entry=found?found.list.splice(found.index,1)[0]:{...descriptor};
        if(found?.list===stacks&&found.index<position)position--;
        if(entry.shortcutTarget){entry=this._relocate(entry,stackPath(entry),entry.shortcutTarget);delete entry.shortcutTarget;}
        stacks.splice(Math.max(0,Math.min(position,stacks.length)),0,entry);
        if(!this._settings.set_string('stacks',JSON.stringify(stacks)))throw new Error('Stack settings are locked');
        await this._removeShortcut(descriptor);
    }
    async removeStack(source) {
        const descriptor=this.descriptor(source);
        if(this._disposed)return;
        const stacks=this._stacks(),found=this.find(stacks,stackKey(descriptor));
        if(!found)return;
        found.list.splice(found.index,1);
        if(!this._settings.set_string('stacks',JSON.stringify(stacks)))throw new Error('Stack settings are locked');
        await this._removeShortcut(descriptor);
    }
    canAdd(source,target) {
        if(this._disposed||!this._settings.is_writable('stacks')||!this.find(this._stacks(),stackKey(target)))return false;
        if(source?.app||source?._stackApp)return true;
        const descriptor=this.descriptor(source);
        return !!descriptor&&!allStacks([descriptor]).some(stack=>stackKey(stack)===stackKey(target));
    }
    async add(source,target) {
        if(!this.canAdd(source,target))throw new Error('A stack cannot contain itself');
        const cancel=new Gio.Cancellable();this._jobs.add(cancel);
        let created;
        try {
            const app=source.app??source._stackApp;
            if(app){
                if(target.appFolder){
                    const folder=new Gio.Settings({schema_id:'org.gnome.desktop.app-folders.folder',path:`${this._folders.path}folders/${target.appFolder}/`});
                    folder.set_strv('excluded-apps',folder.get_strv('excluded-apps').filter(id=>id!==app.get_id()));
                    folder.set_strv('apps',[...new Set([...folder.get_strv('apps'),app.get_id()])]);
                }else created=await copyLauncher(app,Gio.File.new_for_path(stackPath(target)),cancel);
                if(this._disposed||!this.find(this._stacks(),stackKey(target)))throw new Error('The destination stack was removed');
                if(AppFavorites.getAppFavorites().isFavorite(app.get_id()))AppFavorites.getAppFavorites().removeFavorite(app.get_id());
            }else{
                const descriptor=this.descriptor(source);
                let entry={...descriptor};
                if(target.path&&descriptor.path){
                    const shortcut=await linkDirectory(stackPath(descriptor),Gio.File.new_for_path(stackPath(target)),descriptor.name,cancel);
                    created=shortcut.file;entry={...this._relocate(descriptor,stackPath(descriptor),created.get_path()),shortcutTarget:shortcut.target};
                }
                if(this._disposed)throw new Error('Stack operation cancelled');
                const stacks=this._stacks(),destination=this.find(stacks,stackKey(target));
                if(!destination)throw new Error('The destination stack was removed');
                const old=this.find(stacks,stackKey(descriptor));
                if(old)old.list.splice(old.index,1);
                destination.stack.children??=[];destination.stack.children.push(entry);
                if(!this._settings.set_string('stacks',JSON.stringify(stacks)))throw new Error('Stack settings are locked');
                created=null; // settings now own the new shortcut; cleanup cannot roll it back
                await this._removeShortcut(descriptor);
            }
            this.contents.rescan();this._queueRefresh();
        }catch(error){if(created)try{await removeFile(created);}catch{}throw error;}
        finally{this._jobs.delete(cancel);}
    }

    getFolder(id) { return this._folderData.get(id); }

    _syncWatches() {
        const stacks=this._stacks();
        this.contents.sync(stacks);
        const ids = new Set(allStacks(stacks).map(stack => stack.appFolder).filter(Boolean));
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
        this._disposed=true;
        for(const job of this._jobs)job.cancel();
        this.contents.destroy();
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
