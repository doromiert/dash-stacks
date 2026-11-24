"""COPY-only XDND file source for a held gesture originating in Shell.

GTK supplies the native origin surface. XDND negotiation is explicit because
Mutter 50 can expose incorrectly scaled/unmapped Wayland drop proxies, which
GTK's geometric destination lookup cannot discover. No clipboard or fake click.
"""
import json
import os
import sys
import gi
import cairo
from Xlib import X, XK, Xatom, display, protocol

gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
gi.require_version('GdkX11', '3.0')
from gi.repository import Gdk, GdkX11, GLib, Gtk


def trace(event, **values):
    path=os.getenv('DASH_STACKS_DND_TRACE')
    if path:
        with open(path,'a') as output:
            output.write(json.dumps({'event':event,'pid':os.getpid(),**values})+'\n')

def report(event):
    trace(event)
    print(json.dumps({'event': event}), flush=True)


class Source:
    def __init__(self):
        self.finished = False
        self.uri = None
        self.active = False
        self.destination = None
        self.accepted = False
        self.released = False
        self.timer = 0
        self.display = display.Display()
        self.root = self.display.screen().root
        self.escape = self.display.keysym_to_keycode(XK.string_to_keysym("Escape"))
        self.atoms = {name: self.display.intern_atom(name) for name in (
            'XdndSelection', 'XdndAware', 'XdndProxy', 'XdndEnter', 'XdndLeave',
            'XdndPosition', 'XdndDrop', 'XdndStatus', 'XdndFinished',
            'XdndActionCopy', 'XdndActionList', 'text/uri-list', 'TARGETS', 'TIMESTAMP',
            '_DASH_STACKS_DND_TIME', '_NET_SUPPORTING_WM_CHECK')}
        self.source = self.root.create_window(-1, -1, 1, 1, 0, 0, X.InputOnly,
                                              X.CopyFromParent, event_mask=X.PropertyChangeMask)
        self.source.change_property(self.atoms['XdndActionList'], Xatom.ATOM, 32,
                                    [self.atoms['XdndActionCopy']])
        self.window = Gtk.Window(type=Gtk.WindowType.TOPLEVEL, title='Dash Stacks file drag')
        self.window.set_default_size(512, 512)
        self.window.set_decorated(False)
        self.window.set_type_hint(Gdk.WindowTypeHint.UTILITY)
        self.window.set_skip_taskbar_hint(True)
        self.window.set_skip_pager_hint(True)
        self.window.set_accept_focus(False)
        self.window.set_focus_on_map(False)
        self.window.set_keep_above(True)
        self.window.set_app_paintable(True)
        visual = self.window.get_screen().get_rgba_visual()
        if visual:
            self.window.set_visual(visual)
        self.window.connect('draw', self.draw)
        self.input = b""
        os.set_blocking(sys.stdin.fileno(), False)
        GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP, self.command)
        GLib.io_add_watch(self.display.fileno(), GLib.IO_IN, self.events)
        report('ready')

    def draw(self, _window, cr):
        cr.set_operator(cairo.OPERATOR_SOURCE)
        cr.set_source_rgba(0, 0, 0, 0)
        cr.paint()
        return False

    def command(self, fd, condition):
        try:
            chunk = os.read(fd, 65536)
        except BlockingIOError:
            return True
        if not chunk:
            self.finish()
            return False
        self.input += chunk
        while not self.finished and b'\n' in self.input:
            line, self.input = self.input.split(b'\n', 1)
            self.handle(line)
        return not self.finished

    def handle(self, line):
        try:
            message = json.loads(line)
            if self.active:
                self.events()
            if self.finished:
                return
            action = message['action']
            if action == 'start':
                self.uri = message['uri']
                self.window.move(int(message['x']) - 256, int(message['y']) - 256)
                self.window.show_all()
            elif action == 'begin' and self.uri and not self.active:
                self.source.change_property(self.atoms['_DASH_STACKS_DND_TIME'], Xatom.INTEGER, 32, [1])
                self.display.flush()
            elif action == 'position' and self.active and not self.released:
                self.position(message)
            elif action == 'release':
                self.display.ungrab_keyboard(X.CurrentTime)
                trace('release',accepted=self.accepted,destination=self.destination.id if self.destination else None)
                self.released = True
                if self.destination and self.accepted:
                    self.send('XdndDrop', [self.source.id, 0, X.CurrentTime, 0, 0])
                    self.timer = GLib.timeout_add_seconds(15, self.finish)
                else:
                    self.finish()
            elif action == 'cancel':
                self.finish()
        except Exception as error:
            print(f'Dash Stacks drag: {error}', file=sys.stderr, flush=True)
            self.finish()
        return True

    def events(self, *_):
        if self.finished:
            return False
        while not self.finished and self.display.pending_events():
            event = self.display.next_event()
            if event.type == X.PropertyNotify and event.atom == self.atoms['_DASH_STACKS_DND_TIME']:
                self.timestamp = event.time
                self.source.set_selection_owner(self.atoms['XdndSelection'], self.timestamp)
                self.display.flush()
                self.active = True
                self.timer = GLib.timeout_add(60, self.handoff)
            elif event.type == X.KeyPress and event.detail == self.escape:
                self.finish()
            elif event.type == X.SelectionRequest:
                self.selection(event)
            elif event.type == X.SelectionClear:
                self.finish()
            elif event.type == X.ClientMessage:
                values = event.data[1]
                if event.client_type == self.atoms['XdndStatus']:
                    self.accepted = bool(values[1] & 1) and values[4] == self.atoms['XdndActionCopy']
                    trace('status',accepted=self.accepted)
                elif event.client_type == self.atoms['XdndFinished'] and self.released:
                    self.finish()
        return True

    def handoff(self):
        self.timer = 0
        self.window.set_keep_above(False)
        self.window.set_keep_below(True)
        window = self.window.get_window()
        window.shape_combine_region(cairo.Region(), 0, 0)
        window.input_shape_combine_region(cairo.Region(), 0, 0)
        window.lower()
        origin=self.display.create_resource_object('window',self.window.get_window().get_xid())
        origin.grab_keyboard(False, X.GrabModeAsync, X.GrabModeAsync, X.CurrentTime)
        report('started')
        return False

    def proxies(self):
        # Only use the window manager's InputOnly proxies, not an unrelated
        # X11 app's XDND proxy. XIDs encode the owning X client above the
        # resource-ID mask supplied by the X server's connection setup.
        check = self.root.get_full_property(self.atoms['_NET_SUPPORTING_WM_CHECK'], Xatom.WINDOW)
        if not check or not len(check.value):
            return []
        mask = ~self.display.display.info.resource_id_mask
        owner = int(check.value[0]) & mask
        result = []
        for child in self.root.query_tree().children:
            try:
                attributes = child.get_attributes()
                if child.id & mask == owner and attributes.win_class == X.InputOnly and attributes.override_redirect and child.get_full_property(self.atoms['XdndAware'], X.AnyPropertyType):
                    result.append((attributes.map_state == X.IsViewable, child))
            except Exception:
                continue
        return [window for _mapped, window in sorted(result, key=lambda item: item[0], reverse=True)]

    def x11_destination(self):
        window = self.root
        candidates = []
        while window:
            candidates.append(window)
            child = window.query_pointer().child
            window = child if child else None
        for window in reversed(candidates):
            if window.get_full_property(self.atoms['XdndAware'], X.AnyPropertyType):
                proxy = window.get_full_property(self.atoms['XdndProxy'], X.AnyPropertyType)
                if proxy and len(proxy.value):
                    other = self.display.create_resource_object('window', int(proxy.value[0]))
                    check = other.get_full_property(self.atoms['XdndProxy'], X.AnyPropertyType)
                    if check and len(check.value) and int(check.value[0]) == other.id:
                        return other, window.id
                return window, window.id
        return None, None

    def position(self, message):
        if message.get('wayland'):
            if not hasattr(self, 'proxy_windows'):
                self.proxy_windows = self.proxies()
            mapped = [w for w in self.proxy_windows if w.get_attributes().map_state == X.IsViewable]
            destination = next(iter(mapped or self.proxy_windows), None)
            logical_destination = destination.id if destination else None
        else:
            destination, logical_destination = self.x11_destination()
        mapped=destination.get_attributes().map_state==X.IsViewable if destination and message.get('wayland') else None
        key = (destination.id if destination else None, logical_destination, message.get('target'),mapped)
        if key != getattr(self, 'target_key', None):
            if self.destination:
                self.send('XdndLeave', [self.source.id, 0, 0, 0, 0])
            self.destination = destination
            self.logical_destination = logical_destination
            self.target_key = key
            self.accepted = False
            trace('route',key=key,wayland=message.get('wayland'))
            if destination:
                self.send('XdndEnter', [self.source.id, 5 << 24, self.atoms['text/uri-list'], 0, 0])
        if self.destination and message.get('wayland') and not self.accepted:
            now=GLib.get_monotonic_time()
            if now-getattr(self,'last_enter',0)>150000:
                self.send('XdndEnter',[self.source.id,5<<24,self.atoms['text/uri-list'],0,0])
                self.last_enter=now
        if self.destination:
            point = self.root.query_pointer()
            packed = ((point.root_x & 0xffff) << 16) | (point.root_y & 0xffff)
            self.send('XdndPosition', [self.source.id, 0, packed, X.CurrentTime,
                                       self.atoms['XdndActionCopy']])
        self.events()

    def send(self, name, values):
        self.destination.send_event(protocol.event.ClientMessage(
            window=self.logical_destination, client_type=self.atoms[name], data=(32, values)),
            event_mask=X.NoEventMask)
        self.display.flush()

    def selection(self, event):
        trace("selection",target=event.target)
        requestor = event.requestor
        prop = event.property or event.target
        if event.target == self.atoms['TARGETS']:
            requestor.change_property(prop, Xatom.ATOM, 32,
                                      [self.atoms['TARGETS'], self.atoms['TIMESTAMP'], self.atoms['text/uri-list']])
        elif event.target == self.atoms['TIMESTAMP']:
            requestor.change_property(prop, Xatom.INTEGER, 32, [self.timestamp])
        elif event.target == self.atoms['text/uri-list'] and self.uri:
            requestor.change_property(prop, event.target, 8, (self.uri + '\r\n').encode('utf-8'))
        else:
            prop = X.NONE
        requestor.send_event(protocol.event.SelectionNotify(
            time=event.time, requestor=requestor, selection=event.selection,
            target=event.target, property=prop), event_mask=X.NoEventMask)
        self.display.flush()

    def finish(self):
        if self.finished:
            return False
        self.finished = True
        if self.timer:
            GLib.source_remove(self.timer)
            self.timer = 0
        if self.destination and not self.released:
            self.send('XdndLeave', [self.source.id, 0, 0, 0, 0])
        self.display.ungrab_keyboard(X.CurrentTime)
        self.source.destroy()
        self.display.flush()
        self.window.hide()
        report('done')
        Gtk.main_quit()
        return False


Source()
Gtk.main()
