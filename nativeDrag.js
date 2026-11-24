import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';
import GioUnix from 'gi://GioUnix';
import St from 'gi://St';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// St's DND is internal to Shell. A real GTK source exports text/uri-list through
// Mutter's XDND bridge instead. No clipboard replacement or synthetic clicks.
export class NativeFileDrag {
    constructor(directory) {
        this._directory = directory;
        this._process = null;
        this._ready = false;
        this._disabled = false;
        this._startHelper();
    }

    _startHelper() {
        if (this._process || this._disabled)
            return;
        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
            });
            launcher.setenv('GDK_BACKEND', 'x11', true);
            this._process = launcher.spawnv([`${this._directory}/native-drag-helper`]);
            this._input = this._process.get_stdin_pipe();
            GLibUnix.set_fd_nonblocking(GioUnix.OutputStream.prototype.get_fd.call(this._input), true);
            this._pending = [];
            this._writing = false;
            this._ioCancel = new Gio.Cancellable();
            const output = new Gio.DataInputStream({base_stream: this._process.get_stdout_pipe()});
            const read = () => output.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
                try {
                    const [line] = stream.read_line_finish_utf8(result);
                    if (line === null)
                        return;
                    const {event} = JSON.parse(line);
                    if (event === 'ready') this._ready = true;
                    if (event === 'started' && this._active) {
                        this._active.started = true;
                        this._icon = new St.Icon({icon_name:'text-x-generic',icon_size:32});
                        Main.uiGroup.add_child(this._icon);
                        Shell.util_set_hidden_from_pick(this._icon,true);
                    }
                    if (event === 'done') {this._ready=false;this._finish();}
                    read();
                } catch (error) {
                    console.error(`Dash Stacks native drag: ${error.message}`);
                }
            });
            read();
            const process = this._process;
            process.wait_async(null, () => {
                if (this._process !== process) return;
                this._ready = false;
                this._ioCancel.cancel();
                this._process = null;
                this._input = null;
                this._finish();
                if (!this._disabled && process.get_successful()) this._startHelper();
            });
        } catch (error) {
            console.error(`Dash Stacks native drag: ${error.message}`);
            this._process = null;
        }
    }

    _send(message) {
        if (!this._process) return;
        // Coalesce motion; retain ordered start/release/cancel messages. A hung
        // helper must never block Shell's UI thread on a full pipe.
        if (message.action === 'position' && this._pending.at(-1)?.action === 'position')
            this._pending[this._pending.length - 1] = message;
        else
            this._pending.push(message);
        this._flush();
    }

    _flush() {
        if (this._writing || !this._pending.length || !this._process) return;
        this._writing = true;
        const process = this._process;
        const bytes = new TextEncoder().encode(`${JSON.stringify(this._pending.shift())}\n`);
        this._input.write_all_async(bytes, GLib.PRIORITY_DEFAULT, this._ioCancel, (stream, result) => {
            if (this._process !== process) return;
            this._writing = false;
            try {
                stream.write_all_finish(result);
                this._flush();
            } catch (error) {
                if (this._active) console.error(`Dash Stacks native drag: ${error.message}`);
                this._finish();
                process.force_exit();
            }
        });
    }

    watch(item, popup, draggable) {
        // App/stack pins keep their existing Shell drag-and-drop semantics.
        if (item._stackApp || item._stackConfig || item._folderPath)
            return;
        let monitor = null;
        const remove = () => {
            if (monitor) DND.removeDragMonitor(monitor);
            monitor = null;
        };
        const stop = () => {
            remove();
            if (this._preparedItem === item) {
                this._preparedItem = null;
                this._send({action: 'cancel'});
            }
        };
        draggable.connect('drag-begin', () => {
            this._startHelper();
            if (this._ready) {
                const [x,y]=global.get_pointer();
                this._preparedItem=item;
                this._send({action:'start',uri:Gio.File.new_for_path(item.path).get_uri(),x,y});
            }
            monitor = {dragMotion: ({x, y, source}) => {
                if (source !== item || !this._ready || this._active)
                    return DND.DragMotionResult.CONTINUE;
                const [px, py] = popup.get_transformed_position();
                const [width, height] = popup.get_transformed_size();
                if (x >= px && x <= px + width && y >= py && y <= py + height)
                    return DND.DragMotionResult.CONTINUE;
                // Run after Shell has finished iterating the monitor list.
                remove();
                GLib.idle_add_once(GLib.PRIORITY_DEFAULT, () => {
                    if (item._destroyed || !draggable._dragActor) return;
                    this._handoff(item, popup, draggable);
                });
                return DND.DragMotionResult.CONTINUE;
            }};
            DND.addDragMonitor(monitor);
        });
        draggable.connect('drag-end', stop);
        item.connect('destroy', stop);
    }

    _handoff(item, popup, draggable) {
        if (this._disabled || !this._ready) return;
        const [x, y, state] = global.get_pointer();
        if (!(state & Clutter.ModifierType.BUTTON1_MASK)) return;
        const uri = Gio.File.new_for_path(item.path).get_uri();
        const prepared=this._preparedItem===item;
        this._preparedItem=null;
        const dragActor = draggable._dragActor;
        // GNOME 48–50 have no public handoff API. Release Shell's modal grab
        // before hiding Overview, without cancelling/replaying the held press.
        draggable._dragComplete();
        draggable.emit('drag-end', global.get_current_time(), true);
        dragActor.destroy();
        this._active = {started: false, released: false, began: GLib.get_monotonic_time()};
        // Map the native origin before Overview releases its modal grab.
        // Otherwise the held press can latch onto the app underneath first.
        if (!prepared) this._send({action: 'start', uri, x, y});
        Main.overview.hide();
        popup.sourceActor._closePopup();
        this._poll = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            if (!this._active) {this._poll = 0; return GLib.SOURCE_REMOVE;}
            const [cx, cy, buttons] = global.get_pointer();
            if (!this._active.started && !this._active.beginSent) {
                // Keep the tiny transparent source beneath a moving pointer
                // until Xwayland gives it focus and GTK starts the native drag.
                const window = global.get_window_actors().find(actor =>
                    actor.meta_window.get_pid() === Number(this._process?.get_identifier()) &&
                    actor.meta_window.title === 'Dash Stacks file drag' &&
                    !actor.meta_window.is_override_redirect());
                if (window) {
                    const frame = window.meta_window.get_frame_rect();
                    window.meta_window.move_frame(false, Math.round(cx - frame.width / 2), Math.round(cy - frame.height / 2));
                    const picked = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, cx, cy);
                    if (!Main.overview.visible && !Main.overview.animationInProgress &&
                        !global.stage.get_grab_actor() && window.contains(picked)) {
                        this._active.beginSent = true;
                        // Refresh Mutter's pointer focus after the Shell grab
                        // ends, even when the held pointer is stationary.
                        global.stage.context.get_backend().get_default_seat().warp_pointer(cx, cy);
                        this._send({action: 'begin'});
                    }
                }
            }
            if (this._active.started && !this._active.released) {
                this._icon?.set_position(cx+12,cy+12);
                let picked=global.stage.get_actor_at_pos(Clutter.PickMode.ALL,cx,cy);
                while(picked&&!picked.meta_window)picked=picked.get_parent();
                const window=picked?.meta_window;
                this._send({action:'position',wayland:window?.get_client_type()===Meta.WindowClientType.WAYLAND,target:window?.get_stable_sequence()??null});
            }
            if (!(buttons & Clutter.ModifierType.BUTTON1_MASK) && !this._active.released) {
                this._active.released = true;
                if (!this._active.started) {
                    this.cancel();
                    return GLib.SOURCE_REMOVE;
                }
                this._send({action: 'release'});
            }
            if (GLib.get_monotonic_time() - this._active.began > 60_000_000)
                this.cancel();
            return GLib.SOURCE_CONTINUE;
        });
        this._key = global.stage.connect('captured-event', (_stage, event) => {
            if (event.type() === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape)
                this.cancel();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _finish() {
        this._icon?.destroy();
        this._icon=null;
        if (this._poll) GLib.source_remove(this._poll);
        if (this._key) global.stage.disconnect(this._key);
        this._poll = this._key = 0;
        this._active = null;
    }

    cancel() {
        if (this._active) this._send({action: 'cancel'});
        this._finish();
    }

    destroy() {
        this._disabled = true;
        this.cancel();
        this._preparedItem = null;
        this._ioCancel?.cancel();
        this._process?.force_exit();
        this._process = null;
    }
}
