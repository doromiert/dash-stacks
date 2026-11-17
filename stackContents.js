import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

export function stackPath(stack) {
    const path = stack.path;
    return path?.startsWith('~/') ? GLib.get_home_dir() + path.slice(1) : path;
}
export function stackKey(stack) {
    return stack.appFolder ? `folder:${stack.appFolder}` : `path:${stackPath(stack)}`;
}
export function allStacks(stacks) {
    return stacks.flatMap(stack => [stack, ...allStacks(stack.children ?? [])]);
}
const invoke = (object, method, finish, ...args) => new Promise((resolve, reject) => {
    object[method](...args, (source, result) => {
        try { resolve(source[finish](result)); } catch (error) { reject(error); }
    });
});
export const removeFile = (file, cancellable = null) => invoke(file, 'delete_async', 'delete_finish', GLib.PRIORITY_DEFAULT, cancellable);
export async function copyLauncher(app, directory, cancellable) {
    const destination = directory.get_child(app.get_id());
    try {
        const info=await invoke(destination, 'query_info_async', 'query_info_finish', 'standard::type', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        if(info.get_file_type()!==Gio.FileType.REGULAR)throw new Error('The launcher name is already used by another file type');
        return null; // Existing launchers belong to the user; never overwrite them.
    } catch (error) {
        if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) throw error;
    }
    const temporary = directory.get_child(`.dash-stacks-${GLib.uuid_string_random()}`);
    try {
        const source = Gio.File.new_for_path(app.get_app_info().get_filename());
        await invoke(source, 'copy_async', 'copy_finish', temporary, Gio.FileCopyFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable, null);
        await invoke(temporary, 'move_async', 'move_finish', destination, Gio.FileCopyFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable, null);
        return destination;
    } finally {
        try { await removeFile(temporary); } catch { /* already committed or cancelled before creation */ }
    }
}
async function realPath(path, cancellable) {
    const process = Gio.Subprocess.new(['realpath', '-e', '--', path], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const [ok, output, error] = await invoke(process, 'communicate_utf8_async', 'communicate_utf8_finish', null, cancellable);
    if (!ok || !process.get_successful()) throw new Error(error || 'Folder is unavailable');
    return output.trim();
}
export async function linkDirectory(source, target, name, cancellable) {
    const [from, to] = await Promise.all([realPath(source, cancellable), realPath(target.get_path(), cancellable)]);
    if (to === from || to.startsWith(`${from}/`)) throw new Error('A folder cannot contain a shortcut to itself or its parent');
    let basename = name.replace(/[\/\\\x00-\x1f\x7f]/g, '_');
    if (!basename || basename === '.' || basename === '..') basename = 'Folder';
    if(basename.startsWith('.'))basename='_'+basename;
    for (let index=1; index<=1000; index++) {
        const destination = target.get_child(index===1 ? basename : `${basename} (${index})`);
        try {
            await invoke(destination, 'make_symbolic_link_async', 'make_symbolic_link_finish', from, GLib.PRIORITY_DEFAULT, cancellable);
            return {file:destination,target:from};
        } catch (error) {
            if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) throw error;
        }
    }
    throw new Error('No available shortcut name');
}

// Scan only declared stack roots, including nested stack references, never a
// user's arbitrary directory tree. All enumeration and file queries are async.
export class StackContents {
    constructor(changed) {
        this._changed = changed;
        this._paths = new Map();
        this.hidden = new Set();
        this._apps = Shell.AppSystem.get_default();
        this._installedId = this._apps.connect('installed-changed', () => this.rescan());
    }
    sync(stacks) {
        const paths = new Set(allStacks(stacks).map(stackPath).filter(Boolean));
        for (const [path, entry] of this._paths) {
            if (paths.has(path)) continue;
            entry.monitor?.cancel();entry.cancel.cancel();this._paths.delete(path);
        }
        for (const path of paths) {
            if (this._paths.has(path)) continue;
            const file=Gio.File.new_for_path(path), entry={file,ids:new Set(),cancel:new Gio.Cancellable()};
            this._paths.set(path,entry);
            this._watch(path,entry);
            this._scan(path,entry);
        }
        this._publish();
    }
    async _watch(path,entry) {
        const ticket=entry.watchTicket=(entry.watchTicket??0)+1;
        try {
            const target=await realPath(path,entry.cancel);
            if(this._paths.get(path)!==entry||entry.watchTicket!==ticket||entry.watchPath===target)return;
            entry.monitor?.cancel();entry.watchPath=target;
            // Gio directory monitors do not follow a symlink root consistently.
            // Watch its target, but always query membership through the stack path.
            entry.monitor=Gio.File.new_for_path(target).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES,null);
            entry.monitor.connect('changed',(_monitor,child,other)=>{
                for(const changed of [child,other].filter(Boolean)) {
                    if(changed.get_basename().endsWith('.desktop'))this._updateFile(path,entry,changed);
                    else {
                        this.rescan();
                        for(const [root,current] of this._paths)this._watch(root,current);
                    }
                }
                this._changed(false);
            });
            this._scan(path,entry); // include files created while resolving the root
        } catch {
            if(this._paths.get(path)===entry&&entry.watchTicket===ticket){
                entry.monitor?.cancel();entry.monitor=null;entry.watchPath=null;entry.ids.clear();this._publish();
            }
        }
    }
    rescan() { for (const [path,entry] of this._paths) this._scan(path,entry); }
    async _updateFile(path,entry,file) {
        const id=file.get_basename();
        if (!this._apps.lookup_app(id)) return;
        file=entry.file.get_child(id);
        const ticket=(entry.versions??=new Map()).get(id)??0;
        entry.versions.set(id,ticket+1);entry.generation=(entry.generation??0)+1;
        if(entry.scanning)entry.dirty=true;
        let present=false;
        try {
            const info=await invoke(file,'query_info_async','query_info_finish','standard::type',Gio.FileQueryInfoFlags.NONE,GLib.PRIORITY_DEFAULT,entry.cancel);
            present=info.get_file_type()===Gio.FileType.REGULAR;
        } catch(error) {
            if (error.matches(Gio.IOErrorEnum,Gio.IOErrorEnum.CANCELLED)) return;
        }
        if(this._paths.get(path)!==entry||entry.versions.get(id)!==ticket+1)return;
        if(present)entry.ids.add(id);else entry.ids.delete(id);
        this._publish();
    }
    async _scan(path,entry) {
        if(entry.scanning){entry.dirty=true;return;}
        entry.scanning=true;
        const generation=entry.generation=(entry.generation??0)+1;
        let enumerator;
        try {
            enumerator=await invoke(entry.file,'enumerate_children_async','enumerate_children_finish','standard::name,standard::type',Gio.FileQueryInfoFlags.NONE,GLib.PRIORITY_DEFAULT,entry.cancel);
            const ids=new Set();
            for (;;) {
                const batch=await invoke(enumerator,'next_files_async','next_files_finish',64,GLib.PRIORITY_DEFAULT,entry.cancel);
                if(!batch.length)break;
                for(const info of batch){const id=info.get_name();if(info.get_file_type()===Gio.FileType.REGULAR&&id.endsWith('.desktop')&&this._apps.lookup_app(id))ids.add(id);}
            }
            if(this._paths.get(path)===entry&&entry.generation===generation){entry.ids=ids;this._publish();}
        } catch(error) {
            if(!error.matches(Gio.IOErrorEnum,Gio.IOErrorEnum.CANCELLED)){entry.ids.clear();this._publish();}
        } finally {
            if(enumerator)try{await invoke(enumerator,'close_async','close_finish',GLib.PRIORITY_DEFAULT,null);}catch{}
            entry.scanning=false;
            if(entry.dirty&&!entry.cancel.is_cancelled()){entry.dirty=false;this._scan(path,entry);}
        }
    }
    _publish() {
        const ids=new Set([...this._paths.values()].flatMap(entry=>[...entry.ids]));
        if(ids.size===this.hidden.size&&[...ids].every(id=>this.hidden.has(id)))return;
        this.hidden=ids;this._changed(true);
    }
    destroy() {
        this._apps.disconnect(this._installedId);
        for(const entry of this._paths.values()){entry.monitor?.cancel();entry.cancel.cancel();}
        this._paths.clear();this.hidden.clear();this._changed=()=>{};
    }
}
