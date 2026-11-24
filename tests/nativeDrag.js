// Run in an isolated GNOME session with a temporary HOME. The receiver is a
// separate GTK process: calling Shell drop handlers cannot verify native DND.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
const delay = ms => new Promise(resolve => GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, ms, resolve));
const assert = (condition, message) => {if (!condition) throw Error(message);};
async function waitFor(condition, message, timeout = 3000) {
    const end = GLib.get_monotonic_time() + timeout * 1000;
    while (!condition()) {
        assert(GLib.get_monotonic_time() < end, message);
        await delay(20);
    }
}
export async function runNativeDrag(extension, {root, python, typelibPath, scale = 1, backend = 'wayland'}) {
    const call = (method, parameters) => new Promise((resolve, reject) =>
        Gio.DBus.session.call('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig', method, parameters, null, Gio.DBusCallFlags.NONE, -1, null,
            (connection, result) => {try {resolve(connection.call_finish(result).deep_unpack());} catch (error) {reject(error);}}));
    const state = await call('GetCurrentState', null);
    const connector = state[1][0][0][0], mode = state[1][0][1][0][0];
    await call('ApplyMonitorsConfig', new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})',
        [state[0], 1, [[0, 0, scale, 0, true, [[connector, mode, {}]]]], {}]));
    await delay(500);
    const interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const hotCorners = interfaceSettings.get_boolean('enable-hot-corners');
    interfaceSettings.set_boolean('enable-hot-corners', false);
    const settings = extension.getSettings(), saved = settings.get_string('stacks');
    const directory = `${root}/files`;
    GLib.mkdir_with_parents(directory, 0o700);
    const path = `${directory}/hello space #é.txt`;
    GLib.file_set_contents(path, 'Native file drag fixture.\n');
    const dropFile = Gio.File.new_for_path(`${root}/drop.json`);
    const removeDrop = () => {try {dropFile.delete(null);} catch {}};
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
    launcher.setenv('GI_TYPELIB_PATH', typelibPath, true);
    launcher.setenv('GDK_BACKEND', backend, true);
    launcher.setenv('GIO_EXTRA_MODULES', '', true);
    const target = launcher.spawnv([python, `${extension.path}/tests/nativeDropTarget.py`, root]);
    const pointer = global.stage.context.get_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const keyboard = global.stage.context.get_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const motion = (x, y) => pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
    const button = pressed => pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY,
        pressed ? Clutter.ButtonState.PRESSED : Clutter.ButtonState.RELEASED);
    const center = actor => {const [x, y] = actor.get_transformed_position(), [w, h] = actor.get_transformed_size(); return [x + w / 2, y + h / 2];};
    let feedbackMs = 0, maxHeartbeatMs = 0, lastBeat = GLib.get_monotonic_time();
    const heartbeat = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
        const now = GLib.get_monotonic_time();
        maxHeartbeatMs = Math.max(maxHeartbeatMs, (now - lastBeat) / 1000);
        lastBeat = now;
        return GLib.SOURCE_CONTINUE;
    });
    try {
        await waitFor(() => global.get_window_actors().some(actor => actor.meta_window.title === 'Native file drop target'), 'receiver missing');
        const window = global.get_window_actors().find(actor => actor.meta_window.title === 'Native file drop target').meta_window;
        await delay(300);
        window.move_resize_frame(true, 400, 100, 500, 400);
        await delay(300);
        settings.set_string('stacks', JSON.stringify([{name: 'Files', path: directory, icon: 'folder'}]));
        await waitFor(() => extension._nativeDrag._ready, 'helper not ready');
        await delay(500);
        const start = async () => {
            removeDrop();
            Main.overview.show(); await delay(700);
            const stack = extension._buttons.find(item => item._stackButton)?._stackButton;
            stack._togglePopup(); await delay(300);
            const popup = stack.popup;
            await waitFor(() => popup.grid.get_children().some(row => row.get_children().some(item => item.path === path)), 'file missing');
            const item = popup.grid.get_children().flatMap(row => row.get_children()).find(item => item.path === path);
            const [x, y] = center(item);
            motion(x, y); await delay(80); motion(x, y); await delay(50);
            button(true); await delay(60); motion(x, y - 20); await delay(80);
            assert(Main.overview.visible && !extension._nativeDrag._active, 'drag inside popup closed Overview');
            const [, py] = popup.get_transformed_position();
            const began = GLib.get_monotonic_time();
            motion(x, py - 8);
            await waitFor(() => extension._nativeDrag._active || !Main.overview.visible, 'no handoff');
            feedbackMs = Math.max(feedbackMs, (GLib.get_monotonic_time() - began) / 1000);
        };
        const native = async () => {
            await start();
            await waitFor(() => extension._nativeDrag._active?.started, 'native source never started');
            assert(!Main.overview.visible, 'Overview still visible');
        };
        const targetMotion = async () => {
            const [x, y] = global.get_pointer();
            const frame = window.get_frame_rect(), tx = frame.x + frame.width / 2, ty = frame.y + frame.height / 2;
            for (let step = 1; step <= 20; step++) {
                motion(x + (tx - x) * step / 20, y + (ty - y) * step / 20);
                await delay(20);
            }
            await delay(200);
        };
        for (let repetition = 0; repetition < 2; repetition++) {
            await native(); await targetMotion();
            button(false);
            await waitFor(() => dropFile.query_exists(null), 'receiver did not receive file');
            const value = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(`${root}/drop.json`)[1]));
            assert(value.uris[0] === Gio.File.new_for_path(path).get_uri(), 'escaped file URI corrupted');
            await waitFor(() => !extension._nativeDrag._active, 'source did not finish');
            assert(!global.stage.get_grab_actor(), 'Shell modal grab leaked');
        }
        await native(); await targetMotion();
        keyboard.notify_key(GLib.get_monotonic_time(), 1, Clutter.KeyState.PRESSED);
        keyboard.notify_key(GLib.get_monotonic_time(), 1, Clutter.KeyState.RELEASED);
        await waitFor(() => !extension._nativeDrag._active, 'Escape did not cancel');
        button(false); await delay(100);
        assert(!dropFile.query_exists(null), 'Escape dropped a file');
        await start(); button(false);
        await waitFor(() => !extension._nativeDrag._active, 'early release left a drag behind');
        await delay(400);
        assert(!dropFile.query_exists(null), 'early release dropped a file');
        await native();
        motion(global.stage.width - 20, global.stage.height - 20); await delay(150); button(false);
        await waitFor(() => !extension._nativeDrag._active, 'unaccepted drop left a drag behind');
        assert(!dropFile.query_exists(null), 'background accepted a file');
        await native();
        const process = extension._nativeDrag._process;
        process.send_signal(19); // SIGSTOP: verify the Shell never blocks on helper I/O.
        const padding = 'x'.repeat(131072);
        for (let n = 0; n < 2000; n++)
            extension._nativeDrag._send({action: 'position', wayland: false, target: null, padding});
        await delay(100);
        assert(extension._nativeDrag._pending.length <= 1, 'motion queue was not coalesced');
        extension.disable(); button(false); await delay(150);
        assert(process.get_if_exited() || process.get_if_signaled(), 'disable left helper alive');
        assert(!global.stage.get_grab_actor(), 'disable left Shell grabbed');
        extension.enable();
        assert(GLib.file_test(path, GLib.FileTest.EXISTS), 'source file was removed');
        assert(maxHeartbeatMs < 400, `Shell heartbeat stalled for ${maxHeartbeatMs} ms`);
        assert(feedbackMs < 400, `handoff feedback took ${feedbackMs} ms`);
        return {backend, scale, repeatedDrops: 2, escape: true, earlyRelease: true, rejectedDrop: true, stalledHelperCleanup: true, feedbackMs, maxHeartbeatMs};
    } finally {
        GLib.source_remove(heartbeat);
        button(false);
        extension._nativeDrag?.cancel();
        target.force_exit();
        Main.overview.hide();
        settings.set_string('stacks', saved);
        interfaceSettings.set_boolean('enable-hot-corners', hotCorners);
    }
}
